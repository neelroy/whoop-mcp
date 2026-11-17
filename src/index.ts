import { OAuthError, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { AuthHandler } from "./auth";
import { createServer } from "./server";
import { type Props, WhoopTokenError, refreshToken } from "./whoop";

const mcpHandler = createMcpHandler(createServer, { route: "/mcp" });

// WHOOP access tokens last about an hour. Keep ours a little shorter so the
// MCP client refreshes first, and we refresh WHOOP in the same step.
const ACCESS_TOKEN_TTL = 50 * 60;

export default new OAuthProvider<Env>({
	apiRoute: "/mcp",
	apiHandler: {
		fetch(request, env, ctx) {
			return mcpHandler(request, env, ctx);
		},
	},
	defaultHandler: AuthHandler as ExportedHandler<Env>,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
	scopesSupported: ["whoop:read", "offline_access"],
	accessTokenTTL: ACCESS_TOKEN_TTL,
	clientIdMetadataDocumentEnabled: true,
	resourceMetadata: { resource: env.MCP_RESOURCE },

	async tokenExchangeCallback({ grantType, props }) {
		if (grantType !== "refresh_token") return;
		const current = props as Props;
		try {
			const t = await refreshToken(env, current.refreshToken);
			const next: Props = {
				...current,
				accessToken: t.access_token,
				// WHOOP rotates refresh tokens; keep the old one only if none came back.
				refreshToken: t.refresh_token ?? current.refreshToken,
			};
			return { newProps: next, accessTokenTTL: Math.max(60, Math.min(ACCESS_TOKEN_TTL, t.expires_in - 120)) };
		} catch (err) {
			if (err instanceof WhoopTokenError && err.isInvalidGrant) {
				throw new OAuthError("invalid_grant", { description: "WHOOP access was revoked or expired. Sign in again." });
			}
			throw new OAuthError("temporarily_unavailable", { description: "WHOOP is unavailable.", statusCode: 503 });
		}
	},
});
