import {
	AuthorizationError,
	CimdFetchError,
	type ConsentDescription,
	type OAuthHelpers,
	authorizationErrorRedirect,
} from "@cloudflare/workers-oauth-provider";
import { WHOOP_AUTHORIZE_URL, WHOOP_SCOPES, type Props, WhoopClient, exchangeCode } from "./whoop";

type AuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

const escape = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root{color-scheme:light dark;font-family:system-ui,sans-serif}
  body{max-width:30rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
  .card{border:1px solid #8884;border-radius:12px;padding:1.5rem}
  .warn{background:#f5a62322;border-radius:8px;padding:.6rem .8rem}
  button{font:inherit;padding:.55rem 1.2rem;border-radius:8px;border:1px solid #8886;cursor:pointer}
  button.primary{background:#111;color:#fff;border-color:#111}
  ul{padding-left:1.2rem}
</style></head><body><div class="card">${body}</div></body></html>`;

function consentPage(d: ConsentDescription, handle: string) {
	const name = escape(d.clientName || "An MCP client");
	const origin = d.clientDomain
		? `Published by <strong>${escape(d.clientDomain)}</strong>.`
		: "This app registered itself; its name is not verified.";
	return page(
		`Connect ${name} to WHOOP`,
		`<h1>Allow ${name} to read your WHOOP data?</h1>
<p>${origin} Access will be sent to <strong>${escape(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>' : ""}
<p>It will be able to read (not change):</p>
<ul><li>Profile and body measurements</li><li>Cycles, strain and recovery</li><li>Sleep</li><li>Workouts</li></ul>
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <p><button class="primary" name="decision" value="approve">Continue to WHOOP</button>
     <button name="decision" value="deny">Deny</button></p>
</form>`,
	);
}

const errorPage = (message: string, status = 400) =>
	new Response(page("Sign-in failed", `<h1>Sign-in failed</h1><p>${escape(message)}</p><p>Start connecting again from your MCP client.</p>`), {
		status,
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});

async function handle(request: Request, env: AuthEnv): Promise<Response> {
	const url = new URL(request.url);
	const oauth = env.OAUTH_PROVIDER;
	const callbackUrl = `${url.origin}/callback`;

	// GET /authorize: show the consent page for this MCP client.
	if (url.pathname === "/authorize" && request.method === "GET") {
		const authRequest = await oauth.parseAuthRequest(request);
		const details = await oauth.describeConsent(authRequest);
		const consent = await oauth.beginConsent(authRequest);
		consent.headers.set("Content-Type", "text/html; charset=utf-8");
		return new Response(consentPage(details, consent.handle), { headers: consent.headers });
	}

	// POST /authorize: approved → hand the user to WHOOP.
	if (url.pathname === "/authorize" && request.method === "POST") {
		const form = await request.formData();
		const handleValue = String(form.get("handle") ?? "");
		if (form.get("decision") !== "approve") {
			const denied = await oauth.denyConsent(request, handleValue);
			return new Response(null, { status: 302, headers: denied.headers });
		}
		const approved = await oauth.approveConsent(request, handleValue, { scope: ["whoop:read"] });
		const { state, headers } = await oauth.beginUpstream(approved.request, { headers: approved.headers });
		const whoop = new URL(WHOOP_AUTHORIZE_URL);
		whoop.searchParams.set("response_type", "code");
		whoop.searchParams.set("client_id", env.WHOOP_CLIENT_ID);
		whoop.searchParams.set("redirect_uri", callbackUrl);
		whoop.searchParams.set("scope", WHOOP_SCOPES.join(" "));
		whoop.searchParams.set("state", state);
		headers.set("Location", whoop.toString());
		return new Response(null, { status: 302, headers });
	}

	// GET /callback: WHOOP sent the user back.
	if (url.pathname === "/callback" && request.method === "GET") {
		const { request: original, headers } = await oauth.finishUpstream(request);
		const code = url.searchParams.get("code");
		if (url.searchParams.get("error") || !code) {
			headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
			return new Response(null, { status: 302, headers });
		}

		const tokens = await exchangeCode(env, code, callbackUrl);
		if (!tokens.refresh_token) return errorPage("WHOOP did not return a refresh token (is the `offline` scope enabled on your WHOOP app?).", 502);
		const profile = await new WhoopClient(tokens.access_token).profile();
		if (!profile) return errorPage("Could not read your WHOOP profile.", 502);

		const props: Props = {
			whoopUserId: String(profile.user_id),
			name: `${profile.first_name} ${profile.last_name}`.trim(),
			email: profile.email,
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token,
		};
		const { redirectTo } = await oauth.completeAuthorization({
			request: original,
			userId: props.whoopUserId,
			metadata: { label: props.name },
			scope: original.scope,
			props,
		});
		headers.set("Location", redirectTo);
		return new Response(null, { status: 302, headers });
	}

	if (url.pathname === "/") {
		return new Response(
			page("WHOOP MCP", `<h1>WHOOP MCP server</h1><p>Add <code>${escape(env.MCP_RESOURCE)}</code> as a remote MCP server in Claude or another MCP client.</p>`),
			{ headers: { "Content-Type": "text/html; charset=utf-8" } },
		);
	}

	return new Response("Not found", { status: 404 });
}

export const AuthHandler: ExportedHandler<AuthEnv> = {
	async fetch(request, env) {
		try {
			return await handle(request, env);
		} catch (error) {
			if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
			if (error instanceof AuthorizationError) return errorPage(error.description);
			if (error instanceof CimdFetchError) return errorPage("This app could not be verified.");
			console.error("auth error", error);
			return errorPage("Something went wrong talking to WHOOP.", 500);
		}
	},
};
