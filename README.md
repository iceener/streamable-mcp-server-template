# MCP 2026 Server Template

A fetch-native Model Context Protocol server template for **Bun** and **Cloudflare Workers**. Both runtimes use the same MCP server factory, tools, prompts, resources, security policy, and optional OAuth Resource Server boundary.

> **Compatibility status (2026-09-08):** runtime `@modelcontextprotocol/server` and test `@modelcontextprotocol/client` are pinned together to published **2.0.0**, including transitive core 2.0.0. The reference is the npm release, not unreleased SDK `main`. Local tests cover modern `2026-07-28` and stateless legacy `2025-11-25` on Bun and workerd. This is evidence of tested compatibility, **not full current-spec conformance**. See [the compatibility report](docs/MCP_SDK_COMPATIBILITY.md) for provenance, commands, and limitations.

## What the template implements

| Capability | Bun | Workers | Implementation |
|---|---:|---:|---|
| Modern `2026-07-28` HTTP | ✅ | ✅ | `createMcpHandler` with a fresh `McpServer` per request |
| `server/discover` negotiation | ✅ | ✅ | SDK-managed |
| Tools and structured output | ✅ | ✅ | Full Zod v4 Standard Schemas |
| Prompts and completion | ✅ | ✅ | Prompt argument completion example |
| Static and templated resources | ✅ | ✅ | Cache hints, icons, and URI validation |
| Progress and cancellation | ✅ | ✅ | Request-scoped SSE and `AbortSignal` |
| Change subscriptions | ✅ | ✅ | `subscriptions/listen` and handler notifier |
| 2025-era interoperability | ✅ | ✅ | SDK stateless fallback; optional |
| OAuth Resource Server | ✅ | ✅ | JWT/JWKS validation and RFC 9728 metadata |
| Host and Origin validation | ✅ | ✅ | SDK security helpers before dispatch |

The template does **not** implement an OAuth Authorization Server. It relies on an external Authorization Server and validates access tokens intended for this MCP resource. It also intentionally omits deprecated sampling, roots, MCP logging, old direct elicitation, and the removed core Tasks runtime.

## Protocol model

Modern MCP HTTP is stateless:

1. A client negotiates with `server/discover`.
2. Every JSON-RPC request carries its protocol version, client capabilities, and usually client identity in `_meta`.
3. Every request is a separate HTTP `POST`; there is no `Mcp-Session-Id`, endpoint `GET` stream, session `DELETE`, or SSE replay.
4. The SDK validates modern request envelopes and header/body mismatches, and requires `Mcp-Method` and conditional `Mcp-Name`. Send `MCP-Protocol-Version` on every modern request; published 2.0.0 still accepts its omission when the body has a valid modern envelope (rejection is an unreleased upstream change).
5. A terminal response is JSON. Progress or another related message upgrades that request to SSE. `subscriptions/listen` always uses SSE.
6. Closing the request stream is cancellation.

`src/core/runtime.ts` owns one deployment-scoped handler and event bus. Its factory creates a fresh server from `src/core/mcp.ts` for every HTTP request. Do not replace this with a shared `McpServer` or manually call `server.connect()` for modern HTTP.

The default `MCP_LEGACY_MODE=stateless` also accepts 2025-era initialization clients. This fallback does not create sessions and answers legacy `GET`/`DELETE` with `405`. Set `MCP_LEGACY_MODE=reject` for a modern-only endpoint.

## Quick start

Use Bun (tested on 1.4.0) and Node **22+** for Wrangler and the workerd smoke (tested on Node 24.1.0).

### Bun

```bash
bun install
cp .env.example .env
bun run dev
```

Endpoints:

- MCP: `http://localhost:3000/mcp`
- Health: `http://localhost:3000/health`
- Icon: `http://localhost:3000/icon.svg`

Use an MCP v2 client with version negotiation enabled. The v2 client defaults to legacy mode unless configured otherwise:

```ts
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

const client = new Client(
  { name: 'example-client', version: '1.0.0' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);

await client.connect(
  new StreamableHTTPClientTransport(
    new URL('http://localhost:3000/mcp'),
  ),
);
```

### Cloudflare Workers

```bash
bun install
bun run types:worker
bun run dev:worker
```

Before deploying, update these `wrangler.jsonc` values for the real hostname:

- `NODE_ENV` → `production`
- `MCP_PUBLIC_URL` → the public `/mcp` URL
- `MCP_ALLOWED_HOSTS`
- `MCP_ALLOWED_ORIGIN_HOSTNAMES`

Then validate and deploy:

```bash
bun run build:worker
bun run deploy
```

`src/worker.ts` keeps one handler per Worker isolate. That is safe because the handler contains deployment-scoped configuration and active exchanges—not a shared `McpServer` or principal. The default event bus is isolate-local; use a distributed `ServerEventBus` (for example, backed by a Durable Object/pub-sub design) if change notifications must reach subscriptions in every isolate.

## Add a tool

Use a complete Zod v4 object for input and output. The SDK converts the schemas, validates both sides, and requires `structuredContent` for successful results with an output schema.

```ts
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const SearchInput = z.object({
  query: z.string().min(1),
});

const SearchOutput = z.object({
  matches: z.array(z.string()),
});

export function registerSearchTool(server: McpServer): void {
  server.registerTool(
    'search',
    {
      title: 'Search',
      description: 'Search the configured data source.',
      inputSchema: SearchInput,
      outputSchema: SearchOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ query }, ctx) => {
      // Forward cancellation to upstream fetch calls.
      const response = await fetch(`https://api.example.com/search?q=${encodeURIComponent(query)}`, {
        signal: ctx.mcpReq.signal,
      });
      const matches = z.array(z.string()).parse(await response.json());
      return {
        content: [{ type: 'text', text: `Found ${matches.length} matches.` }],
        structuredContent: { matches },
      };
    },
  );
}
```

Register it from `src/shared/tools/registry.ts`. Tool context uses the public v2 interface:

- cancellation: `ctx.mcpReq.signal`
- progress token: `ctx.mcpReq._meta?.progressToken`
- related notifications: `ctx.mcpReq.notify(...)`
- verified HTTP auth: `ctx.http?.authInfo`
- original HTTP request: `ctx.http?.req`

Never derive authorization from `clientInfo`, server metadata, or tool annotations.

## OAuth Resource Server mode

Set `AUTH_ENABLED=true` and configure the external Authorization Server:

```env
MCP_PUBLIC_URL=https://mcp.example.com/mcp
AUTH_ENABLED=true
OAUTH_ISSUER_URL=https://auth.example.com
OAUTH_AUTHORIZATION_URL=https://auth.example.com/authorize
OAUTH_TOKEN_URL=https://auth.example.com/token
OAUTH_JWKS_URL=https://auth.example.com/.well-known/jwks.json
OAUTH_AUDIENCE=https://mcp.example.com/mcp
OAUTH_REQUIRED_SCOPES=mcp:read,mcp:write
OAUTH_RESPONSE_TYPES_SUPPORTED=code
OAUTH_GRANT_TYPES_SUPPORTED=authorization_code
OAUTH_CODE_CHALLENGE_METHODS_SUPPORTED=S256
```

The RFC 8414 capability values above must match the external Authorization Server; the template does not invent unsupported grant or response types. The default verifier in `src/shared/auth/jwt-verifier.ts` verifies:

- JWT signature against remote JWKS
- exact issuer
- exact audience/resource string (no URL normalization of JWT claims)
- allowed algorithms
- expiration
- configured client-ID claim
- required scopes (through the SDK bearer gate)

When enabled, the server publishes:

- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-authorization-server`

Missing or invalid credentials produce a standard `401` challenge with `resource_metadata`; insufficient scopes produce `403`. Access tokens are not forwarded to upstream APIs. If an integration needs provider credentials, supply a custom `OAuthTokenVerifier` and place only the separately validated provider credential in `AuthInfo.extra`—never a refresh token. Custom opaque-token verifiers do not require `OAUTH_JWKS_URL`; the default JWT verifier does.

### External Authorization Server contract for Alice native OAuth

Alice is a **public native client**, not a confidential web client. The external AS must support authorization code + **PKCE S256**, with no embedded client secret. Alice listens only on literal `127.0.0.1` and selects an OS-assigned ephemeral port for `http://127.0.0.1:{port}/oauth/callback`.

If using DCR, register the complete callback selected for that attempt (`application_type=native`, `token_endpoint_auth_method=none` where supported). Bind the returned client ID and exact callback through **registration → authorize → token**. Bind the authorization code to that client, concrete redirect URI, PKCE challenge, requested resource, and granted scopes; redeem it once, with the same redirect URI and matching verifier. Preserve and verify client `state`.

The AS must not use an allow-all redirect validator or pin Alice to a single port. RFC 8252 permits a port-only exception for registered native loopback redirects; it does not permit changing host, path, scheme, or the concrete callback bound to an issued code. For Alice's per-attempt DCR flow, send the same complete URI at all three stages. Do not substitute `localhost`, accept lookalike hosts/userinfo/fragments, or copy a provider web callback into the native flow. See [RFC 8252 §§7.3, 8.4](https://www.rfc-editor.org/rfc/rfc8252) and [RFC 6749 §4.1.3](https://www.rfc-editor.org/rfc/rfc6749#section-4.1.3).

**Native callback ticket: N/A inside this template.** This is an RS only: no DCR, authorize/token endpoints, callback handler, provider OAuth proxy, or token storage. Test this contract in the external AS/Alice integration; local template smokes do not exercise an OAuth browser flow.

## Configuration

See `.env.example`. Important rules:

- URL settings accept only HTTP(S), without userinfo, fragments, whitespace, or control characters. HTTPS is required in production, including loopback; development/tests allow HTTP only on `localhost`, `127.0.0.1`, or `[::1]`.
- `MCP_PUBLIC_URL` must already use its canonical URL spelling and have no query. Noncanonical host casing/default ports/dot segments fail configuration instead of silently changing the resource identifier.
- With auth enabled, `OAUTH_AUDIENCE` must match `MCP_PUBLIC_URL` byte-for-byte; omission defaults to that exact identifier. JWT audience values are compared as strings (including percent-escape spelling). Published SDK `AuthInfo.resource` remains a `URL`; it is not the source of audience comparison.
- `OAUTH_ISSUER_URL` has no query; its exact configured string is used for JWT issuer checks.
- Host and Origin lists contain **hostnames**, not full URLs.
- Requests without `Origin` are allowed for non-browser MCP clients; a present untrusted Origin is rejected with `403` on MCP/application routes. Public OAuth discovery documents keep the SDK's permissive CORS after Host validation.
- Production browser CORS reflects only an Origin that passed validation.
- `MCP_MAX_REQUEST_BYTES` bounds each JSON message before SDK parsing (1 MiB by default).
- Do not configure protocol revision constants yourself; the SDK owns negotiation.
- Rerun `bun run types:worker` after changing Worker bindings or vars.

## Validation

```bash
bun run typecheck
bun run lint
bun run format:check
bun test
bun run build
bun run build:worker
bun run types:worker:check
bun run test:smoke
```

`tests/protocol.test.ts` exercises the official client in-memory, JWT verification, and principal isolation. `tests/wire.test.ts` checks stable raw envelopes, metadata placement, omitted client identity, headers/errors, security, and streamed body limits. `tests/config.test.ts` checks URL and exact-resource validation.

`test:smoke:bun` and `test:smoke:worker` use real HTTP sockets and the official client in both eras. The latter starts actual local workerd through pinned Wrangler 4.130.0, with compatibility date `2026-09-08`; its transitive Miniflare version is `5.20260908.0-alpha`. Both use ephemeral loopback ports and close clients/servers. No deployment, external AS, or provider credentials are needed. Workerd smoke starts Wrangler in Node and runs the client in a separate Bun process.

## Release gate

For each future SDK update:

1. Review the **published** package exports/schema and release changes, separately from `main`.
2. Upgrade exact server/client pins together and inspect the lockfile delta.
3. Run every validation command above, including both real-runtime smokes; regenerate Worker types if config/tooling changes.
4. Check raw `result._meta['io.modelcontextprotocol/serverInfo']` placement, optional client identity, request headers, errors, and both protocol eras.
5. Revisit known stable gaps: missing protocol-header rejection and SDK request-body bounding are unreleased; this app retains its own bound. The unreleased client resource-string fix is not a server API migration.
6. Record evidence and limitations; do not infer full specification conformance or native OAuth integration coverage from these tests.

## Project map

- `src/core/runtime.ts` — modern handler, legacy posture, event bus, lifecycle
- `src/core/mcp.ts` — fresh server factory and cache/capability policy
- `src/http/app.ts` — shared Hono shell, bounded request bodies, and SDK routing
- `src/http/security.ts` — Host, Origin, and CORS policy
- `src/http/auth.ts` — optional OAuth Resource Server gate and metadata
- `src/shared/tools/` — tools using v2 handler context
- `src/shared/prompts/` — prompts and completion
- `src/shared/resources/` — static/template resources and cache hints
- `src/index.ts` / `src/worker.ts` — Bun and Workers entry points

## License

MIT
