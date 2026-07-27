# MCP Template Implementation Guide

Use this checklist to turn the template into a concrete MCP integration without weakening its protocol or security boundaries.

## 1. Keep the serving architecture

Modern `2026-07-28` HTTP is stateless. Preserve these invariants:

- `createMcpHandler` is created once per deployment/isolate.
- Its factory creates a fresh `McpServer` for every request.
- The HTTP shell buffers only a configured, bounded body and reconstructs an unread `Request` for the SDK; it never parses MCP JSON itself.
- Protocol envelopes, HTTP mirror headers, result discriminators, cache fields, subscriptions, and cancellation remain SDK-owned.
- Request/principal data is read from the v2 callback context, never module-level mutable state.
- `Mcp-Session-Id` is not created, persisted, required, or echoed on modern requests.

Choose compatibility explicitly:

```env
# Accept modern and stateless 2025-era clients
MCP_LEGACY_MODE=stateless

# Or reject initialization-based clients
MCP_LEGACY_MODE=reject
```

Do not add a hand-written JSON-RPC dispatcher for Workers. The web-standard SDK handler supports both Bun and Workers.

## 2. Set server identity

Copy `.env.example` to `.env`, then set:

```env
MCP_NAME=my-integration
MCP_TITLE="My Integration"
MCP_VERSION=1.0.0
MCP_DESCRIPTION="Access the My Integration API through MCP."
MCP_INSTRUCTIONS="Start with the account summary before making changes."
MCP_PUBLIC_URL=http://localhost:3000/mcp
```

Before production:

- use the canonical HTTPS endpoint;
- set `MCP_ALLOWED_HOSTS` to the deployed hostnames;
- set `MCP_ALLOWED_ORIGIN_HOSTNAMES` to browser origins you intentionally support;
- update the same values in `wrangler.jsonc` for Workers;
- rerun `bun run types:worker`.

`name` is a stable programmatic identifier. `title` is display text. Do not use either for authorization.

## 3. Replace the example tools

Create a registration module under `src/shared/tools/`. Keep schema, metadata, and callback together when the tool is small.

```ts
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const Input = z.object({
  id: z.string().min(1),
});

const Output = z.object({
  id: z.string(),
  title: z.string(),
});

export function registerGetItem(server: McpServer): void {
  server.registerTool(
    'get_item',
    {
      title: 'Get Item',
      description: 'Get one item by its stable identifier.',
      inputSchema: Input,
      outputSchema: Output,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id }, ctx) => {
      const response = await fetch(`https://api.example.com/items/${encodeURIComponent(id)}`, {
        signal: ctx.mcpReq.signal,
      });
      if (!response.ok) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Item lookup failed (${response.status}).` }],
        };
      }

      const item = Output.parse(await response.json());
      return {
        content: [{ type: 'text', text: `${item.title} (${item.id})` }],
        structuredContent: item,
      };
    },
  );
}
```

Then call the registration function from `src/shared/tools/registry.ts`.

### Tool contract rules

- Use Zod v4 (`zod/v4`) or another Standard Schema implementation.
- Pass full schema objects, not raw Zod shapes.
- Tool input schema roots must be objects.
- Output schemas may use any JSON root supported by the protocol.
- A successful result with `outputSchema` must include valid `structuredContent`.
- Keep a text rendering in `content` for older clients and LLM readability.
- Return `isError: true` for expected tool/upstream failures.
- Let unknown tools, invalid protocol parameters, and internal dispatch failures remain JSON-RPC errors.
- Sanitize upstream errors; do not return credentials, stack traces, or private response bodies.

### Progress and cancellation

Only emit progress when the client supplied a token:

```ts
const token = ctx.mcpReq._meta?.progressToken;
if (token !== undefined) {
  await ctx.mcpReq.notify({
    method: 'notifications/progress',
    params: {
      progressToken: token,
      progress: 1,
      total: 3,
      message: 'Loaded the first page',
    },
  });
}
```

Progress values must strictly increase and stop after completion. Forward `ctx.mcpReq.signal` to `fetch` and other cancellable APIs. Do not recreate cancellation registries.

## 4. Add prompts, resources, and completion only when useful

- Register prompts in `src/shared/prompts/index.ts` with a complete `argsSchema`.
- Wrap completable prompt arguments with `completable(schema, callback)`.
- Register static and templated resources in `src/shared/resources/index.ts`.
- A `ResourceTemplate` must explicitly set `list`, even when it is `undefined`.
- Reject unknown or unauthorized resource URIs; protect filesystem resources from traversal and symlink escapes.
- Mark public immutable resources with a public cache hint. Keep user-specific data private.

The SDK infers primitive capabilities from registrations. Do not advertise a capability unless every required method works in that runtime.

## 5. Use verified authentication context

With OAuth enabled, request flow is:

```text
Authorization: Bearer <access token>
  -> OAuthTokenVerifier
  -> SDK requireBearerAuth gate
  -> AuthInfo
  -> handler.fetch(request, { authInfo })
  -> ctx.http.authInfo
```

Read only verified fields in a tool:

```ts
const auth = ctx.http?.authInfo;
if (!auth) {
  return {
    isError: true,
    content: [{ type: 'text', text: 'Authentication required.' }],
  };
}

const clientId = auth.clientId;
const subject =
  typeof auth.extra?.subject === 'string' ? auth.extra.subject : undefined;
```

Do not forward `auth.token` to an upstream API. It is an access token for this MCP resource. If the integration needs a different provider credential, implement a custom `OAuthTokenVerifier` at composition time and attach only a separately validated short-lived provider credential to `AuthInfo.extra`.

### External Authorization Server configuration

```env
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

The default verifier checks signature, issuer, audience, algorithms, expiration, client ID, and scopes. The advertised response, grant, and PKCE values must match the external Authorization Server's real metadata. This template does not own `/authorize`, `/token`, `/register`, callbacks, refresh tokens, or provider-token storage.

## 6. Publish change events correctly

Per-request `McpServer` objects disappear after the exchange. Publish modern change notifications through the deployment-scoped runtime:

```ts
runtime.notify.toolsChanged();
runtime.notify.promptsChanged();
runtime.notify.resourcesChanged();
runtime.notify.resourceUpdated('example://items/books/1');
```

The default event bus is in-process. It is process-local on Bun and isolate-local on Workers. Supply a shared `ServerEventBus` when a multi-process or multi-isolate deployment requires global delivery.

## 7. Avoid removed and deprecated surfaces

Do not add new code based on:

- initialization/session state for modern HTTP;
- endpoint GET streams, DELETE sessions, `Last-Event-ID`, or SSE replay;
- direct server-to-client JSON-RPC requests on the modern revision;
- `logging/setLevel` or MCP protocol logging;
- roots or sampling for new integrations;
- old elicitation completion notifications;
- core Tasks APIs from `2025-11-25`;
- private SDK imports or casts around `server.server`.

Modern user input uses multi-round-trip `input_required` results. If you add it, integrity-protect `requestState` with `createRequestStateCodec`, bind it to the authenticated principal/method, validate every input response, and test tampered and expired state.

## 8. Test the integration

Extend `tests/protocol.test.ts` with the real tools and resources. At minimum, cover:

- modern pinned negotiation and `server/discover`;
- the selected legacy posture;
- input and structured-output schema failures;
- tool success and expected `isError` failures;
- progress monotonicity and request cancellation;
- resource/prompt lookup failures;
- missing, invalid, expired, wrong-audience, and insufficient-scope tokens;
- concurrent authenticated principals;
- Host and Origin rejection;
- Workers dry-run bundling.

Run:

```bash
bun run typecheck
bun run lint
bun run format:check
bun test
bun run build
bun run build:worker
bun run types:worker:check
```

## 9. Production review

Before release:

- pin and review the final MCP SDK/spec revision;
- use HTTPS and exact production allowlists;
- keep Authorization Server and JWKS URLs under trusted control;
- set explicit JWT algorithms and required scopes;
- set `MCP_MAX_REQUEST_BYTES` and add application rate limits/timeouts appropriate to each tool;
- bound external response sizes before buffering;
- use structured logs without tokens or PII;
- verify cross-isolate subscription requirements;
- test graceful Bun shutdown and Worker deployment;
- rerun the protocol suite with the official client.
