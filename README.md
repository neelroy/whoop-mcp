# WHOOP MCP server on Cloudflare Workers

A remote MCP server that lets Claude (or any MCP client) read your WHOOP data.
Clients sign in with OAuth: the server shows a consent page, sends you to WHOOP to log in,
and stores your WHOOP tokens encrypted in Workers KV. It refreshes them automatically.

## Tools

| Tool | What it returns |
| --- | --- |
| `get_today` | Current cycle + its recovery + last night's sleep |
| `get_recoveries` | Recovery %, HRV, resting HR, SpO2, skin temp over a date range |
| `get_sleeps` | Sleep stages, performance, efficiency, respiratory rate |
| `get_workouts` | Sport, strain, HR, kJ, distance, HR zones |
| `get_cycles` | Daily strain, kJ, average/max HR |
| `get_profile` | Name, email, height, weight, max HR |
| `get_sleep_by_id`, `get_workout_by_id` | A single record by UUID |

Range tools take optional `start` / `end` (ISO 8601) and `limit` (1–200, default 10).

## Deploy

### 1. Log in to Cloudflare and create the KV namespace

```bash
npm install
```

```bash
npx wrangler login
```

```bash
npx wrangler kv namespace create OAUTH_KV
```

Paste the printed `id` into `wrangler.jsonc` in place of `REPLACE_WITH_KV_ID`.

### 2. First deploy (to learn your URL)

```bash
npx wrangler deploy
```

It prints something like `https://whoop-mcp.<your-subdomain>.workers.dev`.
Set `MCP_RESOURCE` in `wrangler.jsonc` to that URL plus `/mcp`.

### 3. Create a WHOOP developer app

At <https://developer-dashboard.whoop.com>, create an app with:

- **Redirect URL:** `https://whoop-mcp.<your-subdomain>.workers.dev/callback`
- **Scopes:** `offline`, `read:profile`, `read:body_measurement`, `read:cycles`, `read:recovery`, `read:sleep`, `read:workout`

### 4. Add the WHOOP credentials as secrets and redeploy

```bash
npx wrangler secret put WHOOP_CLIENT_ID
```

```bash
npx wrangler secret put WHOOP_CLIENT_SECRET
```

```bash
npx wrangler deploy
```

### 5. Connect Claude

In Claude, go to **Settings → Connectors → Add custom connector**. Enter
`https://whoop-mcp.<your-subdomain>.workers.dev/mcp`, then approve the consent page and log in to WHOOP.

## Local development

```bash
cp .dev.vars.example .dev.vars
```

Fill in `.dev.vars` and add `http://localhost:8787/callback` as a redirect URL on your WHOOP app. Then run:

```bash
npm run dev
```

Test the server with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector
```

## How it works

- `src/index.ts`: `OAuthProvider` serves `/authorize`, `/token`, `/register` and the `.well-known` metadata, and guards `/mcp`. Its `tokenExchangeCallback` refreshes the WHOOP token whenever the MCP client refreshes. MCP access tokens last 50 minutes, so they expire before WHOOP's 1-hour tokens do.
- `src/auth.ts`: the consent page, the redirect to WHOOP, and the `/callback` code exchange.
- `src/server.ts`: the MCP tools (stateless `createMcpHandler`, MCP SDK v2).
- `src/whoop.ts`: the WHOOP v2 API client with `next_token` pagination.
