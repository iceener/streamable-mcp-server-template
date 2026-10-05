# Architecture

The template is the SDK's recommended remote-server setup, plus the few things a production server needs on top. If you know the [SDK docs](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/docs), every piece here should look familiar. Each addition is listed below with the reason it exists.

## A request, start to finish

```
          Bun.serve (src/bun.ts)      Workers fetch (src/worker.ts)
                       \                 /
                        createApp(config)                  platform/app.ts
                               │
   ┌───────────────────────── Hono ──────────────────────────┐  platform/http.ts
   │ 1. Host allowed?                    no → 403            │  SDK hostHeaderValidationResponse
   │ 2. OAuth discovery document?        yes → serve it      │  SDK oauthMetadataResponse
   │ 3. Origin allowed?                  no → 403            │  SDK originValidationResponse
   │ 4. /mcp                                                 │
   │      OPTIONS → CORS preflight                           │  platform/cors.ts
   │      bearer token valid?            no → 401 / 403      │  SDK requireBearerAuth
   │      drop the token and the Authorization header        │
   └───────────────────────────┬─────────────────────────────┘
                               │ handler.fetch(request, { authInfo })
                     createMcpHandler (SDK)
         body limit · batch limit · protocol era · headers · errors
                               │ per request
                  createServer(deps)() → new McpServer          src/server.ts
                               │
             tools / resources / prompts → services             src/tools, src/services …
```

The SDK owns everything between the HTTP request and your handler: reading and bounding the body, protocol negotiation, the 2025-era fallback, header validation, JSON-RPC errors, progress and cancellation. The template sets up what goes in front of that and what comes after it.

## What the template adds, and why

| Addition | Where | Why |
|---|---|---|
| Host and Origin checks on every route | `http.ts` | The SDK handler trusts its caller; the SDK docs say to put these in front of it. They stop DNS-rebinding and cross-site requests |
| OAuth resource server | `auth.ts`, `jwt.ts` | `requireBearerAuth` with `expectedResource`, so only tokens issued for this server's URL are accepted |
| Credentials removed before handlers | `http.ts` | The MCP spec forbids passing a client's token to other APIs. Handlers see the verified caller, but neither the token nor the `Authorization` header, so they can't pass it on by mistake |
| `defineTool` / `defineResource` / `definePrompt` | `primitives.ts` | One error policy for tool calls, resource reads, template `list` and `complete` callbacks, and prompt gets. Unexpected errors are logged with a reference, and the client sees only the reference. With an `outputSchema`, tools must return matching `structuredContent`, checked at compile time |
| Validated configuration | `config.ts` | Wrong settings, including your own in `settings.ts`, are reported together before the first request is served |
| A server built at startup | `app.ts` | A registration mistake, such as a duplicate tool name, is caught when the app is built: Bun refuses to start, and a Worker logs it once instead of failing each request with a different error |
| Structured, redacting logger | `logger.ts` | JSON lines that Workers Logs can filter. Secrets are removed by field name and by common value shapes: bearer and basic credentials, JWTs, and credentials in URLs |
| Bun `idleTimeout` | `bun.ts` | Bun's 10 s default drops SSE streams that go quiet between progress updates |

## Where your code meets the platform

`platform/` imports from exactly two project files, and only these names:

| File | Exports | Used for |
|---|---|---|
| `src/server.ts` | `serverInfo`, `SERVER_ICON_PATH`, `SERVER_ICON_SVG` | Identity: `/health`, `/icon.svg`, OAuth metadata |
| | `Runtime`, `Deps`, `createDeps` | What every handler receives, built once at startup from the runtime's resources |
| | `createServer` | The per-request `McpServer` factory |
| | `createVerifier` | How bearer tokens are checked in OAuth mode |
| | `oauthMetadata` | The authorization server metadata published in OAuth mode |
| | `routes` | Extra HTTP routes (webhooks, OAuth callbacks), behind the Host and Origin checks |
| `src/settings.ts` | `Settings` | Your own settings, validated with the platform's |

The entry points, `src/bun.ts` and `src/worker.ts`, are yours too: they build the `Runtime` from what their platform provides (Workers bindings such as KV, D1 and Durable Objects, or local stand-ins on Bun), and `src/worker.ts` exports your Durable Object classes.

Keep those names and shapes, and a newer template's `platform/` drops in. Changing `platform/` itself should be rare, for example to tune transport options in `app.ts`; keep such changes small so they're easy to carry forward.

## Decisions

**A fresh `McpServer` per request.** `createMcpHandler` calls the factory in `src/server.ts` for every HTTP request, as the SDK requires since 2.3.0. Building a server is cheap, because tool schemas are converted lazily, so the factory just registers definitions. Anything expensive, such as API clients or connection pools, belongs in `deps`, which is built once.

**Stateless.** Protocol 2026-07-28 has no sessions; each request carries its own metadata. 2025-era clients are served through the SDK's stateless fallback (`MCP_LEGACY_MODE=stateless`), which means they can't receive server-to-client requests mid-call. `confirm-action` shows what they get instead. Set `MCP_LEGACY_MODE=reject` to serve 2026-07-28 clients only.

**Dependencies are passed in, not imported.** `Deps` holds config, the logger and service clients. Every handler receives it as its last argument. Tests swap in fakes (`tests/helpers.ts`); nothing reads globals.

**Services know nothing about MCP.** `src/services/weather.ts` takes an `AbortSignal`, validates responses, and throws `UpstreamError` for outages. The tool decides what the model is told. Services get their credentials from `config.settings`, never from the caller's token.

**Hono, but not `@modelcontextprotocol/hono`.** Hono gives you somewhere to add routes such as webhooks and OAuth callbacks, and every route gets the same guards. The SDK's Hono package defaults to localhost-only Host checks and answers malformed JSON with plain text. It adds nothing here that the SDK's fetch helpers don't already provide.

**No client-facing logging.** MCP's logging capability is deprecated in protocol 2026-07-28. Logs go to stdout as JSON instead.

## Change notifications

The server advertises `listChanged: false` and `subscribe: false`. Tool, prompt and resource lists change only when you deploy, and with one server instance per request there is no long-lived instance to notify from. Advertising them would let clients hold `subscriptions/listen` streams open for events that never arrive.

If your resources do change while the server runs (a file, a record in a database):

1. Give `createMcpHandler` a shared `bus` that implements `ServerEventBus`. The default bus works within one process only. Every Worker isolate is a separate process, so on Workers back the bus with a Durable Object; on Bun use Redis or similar when you run more than one instance.
2. Publish through `handler.notify.resourceUpdated(uri)` or `handler.notify.toolsChanged()` where the change happens.
3. Advertise the matching capabilities in `src/server.ts`.

The SDK's [notifications guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/notifications.md) and [scaling guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/sessions-state-scaling.md) cover the details.

## Not included

- **An OAuth authorization server.** Use a dedicated identity provider. The SDK's own authorization-server helpers are frozen in `@modelcontextprotocol/server-legacy`.
- **Sessions and resumable streams.** These belong to the 2025-era protocol. If you need them, see the SDK's sessions guide.
- **Sampling and roots.** Both are deprecated in protocol 2026-07-28. To ask the user for input, use `input_required` with elicitation, as `confirm-action` does.
