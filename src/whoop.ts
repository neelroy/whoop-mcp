// Minimal client for the WHOOP Developer API (v2) and its OAuth endpoints.

export const WHOOP_AUTHORIZE_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
export const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
export const WHOOP_API_BASE = "https://api.prod.whoop.com/developer";

// `offline` is required for WHOOP to return a refresh token.
export const WHOOP_SCOPES = [
	"offline",
	"read:profile",
	"read:body_measurement",
	"read:cycles",
	"read:recovery",
	"read:sleep",
	"read:workout",
];

/** What we keep (encrypted) in each grant and hand to tool calls. */
export type Props = {
	whoopUserId: string;
	name: string;
	email: string;
	accessToken: string;
	refreshToken: string;
};

export type WhoopTokenResponse = {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	scope?: string;
	token_type: string;
};

export class WhoopTokenError extends Error {
	constructor(
		readonly status: number,
		readonly body: string,
	) {
		super(`WHOOP token endpoint returned ${status}`);
	}
	/** True when the refresh token is dead for good (revoked, expired, already used). */
	get isInvalidGrant() {
		return this.status === 400 || this.status === 401 || this.body.includes("invalid_grant");
	}
}

async function tokenRequest(params: Record<string, string>): Promise<WhoopTokenResponse> {
	const res = await fetch(WHOOP_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(params),
	});
	const text = await res.text();
	if (!res.ok) throw new WhoopTokenError(res.status, text);
	return JSON.parse(text) as WhoopTokenResponse;
}

export function exchangeCode(env: Env, code: string, redirectUri: string) {
	return tokenRequest({
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri,
		client_id: env.WHOOP_CLIENT_ID,
		client_secret: env.WHOOP_CLIENT_SECRET,
	});
}

export function refreshToken(env: Env, refresh: string) {
	return tokenRequest({
		grant_type: "refresh_token",
		refresh_token: refresh,
		client_id: env.WHOOP_CLIENT_ID,
		client_secret: env.WHOOP_CLIENT_SECRET,
		scope: "offline",
	});
}

export class WhoopApiError extends Error {
	constructor(
		readonly status: number,
		readonly path: string,
		readonly body: string,
	) {
		super(
			status === 401
				? "WHOOP rejected the access token. Reconnect this MCP server to sign in to WHOOP again."
				: status === 429
					? "WHOOP rate limit reached. Try again in a minute."
					: `WHOOP API error ${status} on ${path}: ${body.slice(0, 300)}`,
		);
	}
}

export class WhoopClient {
	constructor(private accessToken: string) {}

	async get<T = unknown>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T | null> {
		const url = new URL(WHOOP_API_BASE + path);
		for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
		const res = await fetch(url, { headers: { Authorization: `Bearer ${this.accessToken}` } });
		if (res.status === 404) return null;
		if (!res.ok) throw new WhoopApiError(res.status, path, await res.text());
		return (await res.json()) as T;
	}

	/** Follows `next_token` pagination (25 records per page max) until `max` records. */
	async collection<T = unknown>(
		path: string,
		opts: { start?: string; end?: string; max: number },
	): Promise<T[]> {
		const out: T[] = [];
		let nextToken: string | undefined;
		do {
			const page = await this.get<{ records: T[]; next_token?: string | null }>(path, {
				limit: Math.min(25, opts.max - out.length),
				start: opts.start,
				end: opts.end,
				nextToken,
			});
			if (!page) break;
			out.push(...page.records);
			nextToken = page.next_token ?? undefined;
		} while (nextToken && out.length < opts.max);
		return out;
	}

	profile() {
		return this.get<{ user_id: number; email: string; first_name: string; last_name: string }>(
			"/v2/user/profile/basic",
		);
	}
}
