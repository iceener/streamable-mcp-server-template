# Troubleshooting

## The server won't start

`Invalid configuration:` is followed by every problem found. Each line names the variable involved; `.env.example` describes them all. In production, `MCP_PUBLIC_URL` and `AUTH_MODE` are required, and every URL must use HTTPS.

`EADDRINUSE`: something else is using the port. Set `PORT=3100` and change the URL your client uses to match.

## 403 on every request

The Host or Origin check is rejecting the request. Requests must arrive with a `Host` header whose hostname is in `MCP_ALLOWED_HOSTS`. Browser requests must also have an `Origin` hostname in `MCP_ALLOWED_ORIGIN_HOSTNAMES`. Entries are bare hostnames: `mcp.example.com`, not `https://mcp.example.com` or `mcp.example.com:443`.

- Behind a proxy, make sure it forwards the original `Host`.
- A Worker deployed without `--env production` has the development settings and refuses everything. Use `bun run deploy`.

## 401 with a token that should work

Set `LOG_LEVEL=debug` and look for `Rejected access token`; `reason` and `detail` say which check failed. Most often:

- **`aud`** doesn't contain `MCP_PUBLIC_URL` exactly. Look for a trailing slash, a different host, or http instead of https. Configure the authorization server to use your public URL as the token audience.
- **`iss`** isn't exactly `OAUTH_ISSUER_URL`. Some providers add a trailing slash.
- **The token isn't a JWT.** Use [another verifier](auth.md#verify-tokens-another-way).

To read a token's claims, decode its middle segment: `echo '<token>' | cut -d. -f2 | base64 -d`.

## 500 `server_error` with OAuth on

The server couldn't fetch `OAUTH_JWKS_URL`. The log says `Could not load the authorization server key set`. Check the URL and that the server can reach it.

## 400 with error code -32020

The client sent `MCP-Protocol-Version`, `Mcp-Method` or `Mcp-Name` headers that don't match the request body, or left one out. Protocol 2026-07-28 requires them on every request; the official SDK clients send them. A client that doesn't is out of date or hand-written.

## 413

The request body is larger than `MCP_MAX_REQUEST_BYTES` (4 MiB by default).

## A tool says "failed because of an internal error (reference …)"

The handler threw something unexpected. Search the logs for the reference: the `Unexpected tool failure` entry has the real error and its stack. To show the model a useful message for a failure you expect, return `toolError(...)`; see [tools.md](tools.md#errors).

## `confirm-action` fails for some clients

Clients that only speak the 2025-era protocol are served without a session, and the server can't ask them anything mid-call. They receive a tool error that says so. Clients that speak 2026-07-28 answer the question and call again.

## Long tool calls disconnect

On Bun, check that `src/bun.ts` still sets `idleTimeout`; Bun's 10 s default drops quiet streams. Behind a proxy, raise its read timeout and turn off response buffering for `/mcp`. Report progress from long tools: progress keeps the connection busy and tells the user something is happening.

## `wrangler dev` uses the wrong settings

The Worker scripts tell Wrangler not to load `.env`, which holds the Bun settings. Put Worker-only local values in `.dev.vars`; it overrides `vars` in `wrangler.jsonc`. After you edit `wrangler.jsonc`, run `bun run types:worker`.

## MCP Inspector can't connect

Choose **Streamable HTTP**, not SSE, and use the full URL including `/mcp`. If the Inspector runs on a different host than the server, add its hostname to `MCP_ALLOWED_ORIGIN_HOSTNAMES`.
