# MCP 2026 Server Template

A fetch-native Model Context Protocol server template for **Bun** and **Cloudflare Workers**. Both runtimes use the same MCP server factory, tools, prompts, resources, security policy, and optional OAuth Resource Server boundary.

> **Release status (2026-07-27):** this repository intentionally pins `@modelcontextprotocol/server` and `@modelcontextprotocol/client` to `2.0.0-beta.5`. That is the latest published SDK implementing the `2026-07-28` release candidate. The dated protocol and stable v2 SDK are expected on July 28 but are not final at this commit. Re-run the release gate below before claiming final conformance.

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
4. The SDK validates modern request envelopes and mirrored `MCP-Protocol-Version`, `Mcp-Method`, and conditional `Mcp-Name` headers.
5. A terminal response is JSON. Progress or another related message upgrades that request to SSE. `subscriptions/listen` always uses SSE.
6. Closing the request stream is cancellation.

`src/core/runtime.ts` owns one deployment-scoped handler and event bus. Its factory creates a fresh server from `src/core/mcp.ts` for every HTTP request. Do not replace this with a shared `McpServer` or manually call `server.connect()` for modern HTTP.

The default `MCP_LEGACY_MODE=stateless` also accepts 2025-era initialization clients. This fallback does not create sessions and answers legacy `GET`/`DELETE` with `405`. Set `MCP_LEGACY_MODE=reject` for a modern-only endpoint.

## Quick start

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
- audience/resource
- allowed algorithms
- expiration
- configured client-ID claim
- required scopes (through the SDK bearer gate)

When enabled, the server publishes:

- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-authorization-server`

Missing or invalid credentials produce a standard `401` challenge with `resource_metadata`; insufficient scopes produce `403`. Access tokens are not forwarded to upstream APIs. If an integration needs provider credentials, supply a custom `OAuthTokenVerifier` and place only the separately validated provider credential in `AuthInfo.extra`—never a refresh token. Custom opaque-token verifiers do not require `OAUTH_JWKS_URL`; the default JWT verifier does.

## Configuration

See `.env.example`. Important rules:

- `MCP_PUBLIC_URL` must be the canonical endpoint and HTTPS in production.
- Host and Origin lists contain **hostnames**, not full URLs.
- Requests without `Origin` are allowed for non-browser MCP clients; a present untrusted Origin is rejected with `403`.
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
```

`tests/protocol.test.ts` runs the official v2 client against the in-memory HTTP app in both modern and legacy modes. It covers discovery, tools, structured output, prompts, completion, resources, cache hints, progress, cancellation, subscriptions, header mismatch errors, Origin rejection, OAuth metadata, and concurrent principal isolation.

## Release gate

When the final `2026-07-28` specification and stable v2 packages are published:

1. Diff the final specification/schema against the release candidate.
2. Upgrade the exact SDK pins together; do not mix package versions.
3. Re-run the full validation list.
4. Check whether `serverInfo` placement or required request metadata changed from beta.5.
5. Only then replace the release-status warning and claim final conformance.

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
