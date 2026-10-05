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

To read a token's claims without sending it anywhere:

```sh
bun -e 'console.log(JSON.parse(Buffer.from(process.argv[1].split(".")[1], "base64url").toString()))' '<token>'
```

## 500 `server_error` with OAuth on

The server couldn't fetch or read `OAUTH_JWKS_URL`: it was unreachable, answered with an error, or didn't return a key set. The log says `Could not load the authorization server key set`. Open the URL yourself and check that it returns JSON with a `keys` array.

## 400 with error code -32020

The client sent `MCP-Protocol-Version`, `Mcp-Method` or `Mcp-Name` headers that don't match the request body, or left one out. Protocol 2026-07-28 requires the first two on every request, and `Mcp-Name` on requests that name something, such as `tools/call`, `prompts/get` and `resources/read`. The official SDK clients send them; a client that doesn't is out of date or hand-written.

## 400 that names `MCP-Protocol-Version`

After initialize, a 2025-era client sends the protocol version it negotiated in the `MCP-Protocol-Version` header. The server accepts `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05` and `2024-10-07`. A request without the header is served as `2025-03-26`, as the specification requires for older clients.

Any other value gets `400` before a handler runs:

- `-32000` "Unsupported protocol version": the client uses a version this server doesn't support.
- `-32602` "missing the required per-request envelope": the header names `2026-07-28` or a later revision, but the body is in the 2025 format. The client, or a proxy in front of the server, mixed the two.

`tests/sdk-contract.test.ts` pins this behavior.

## 413

The request body is larger than `MCP_MAX_REQUEST_BYTES` (4 MiB by default).

## A tool says "failed with an internal error (reference …)"

The handler threw something unexpected. Search the logs for the reference: the `Unexpected tool failure` entry has the real error and its stack. Resources and prompts answer `Internal error (reference …)` the same way. To show the model a useful message for a failure you expect, return `toolError(...)`; see [tools.md](tools.md#errors).

## "already registered"

Two tools, resources or prompts share a name. The server builds itself once at startup to catch this: Bun stops with the error, and a Worker logs `The server failed to start` and answers every request with a 500. Rename one of them.

## `confirm-action` fails for some clients

It needs a client that can show a form (elicitation). A 2026-07-28 client without that capability gets error `-32021` naming it. Clients that only speak the 2025-era protocol are served without a session, so the server can't ask them anything mid-call; they get a tool error that says so. In both cases nothing runs.

## Long tool calls disconnect

On Bun, check that `src/bun.ts` still sets `idleTimeout`; Bun's 10 s default drops quiet streams. Behind a proxy, raise its read timeout and turn off response buffering for `/mcp`. The SDK also sends a keepalive comment on open streams every 15 s, which `keepAliveMs` on `createMcpHandler` (in `src/platform/app.ts`) changes. Report progress from long tools: progress keeps the connection busy and tells the user something is happening.

## `wrangler dev` uses the wrong settings

The Worker scripts tell Wrangler not to load `.env`, which holds the Bun settings. Put Worker-only local values in `.dev.vars`; it overrides `vars` in `wrangler.jsonc`. After you edit `wrangler.jsonc`, run `bun run types:worker`.

## MCP Inspector can't connect

Choose **Streamable HTTP**, not SSE, and use the full URL including `/mcp`. If the Inspector runs on a different host than the server, add its hostname to `MCP_ALLOWED_ORIGIN_HOSTNAMES`.
