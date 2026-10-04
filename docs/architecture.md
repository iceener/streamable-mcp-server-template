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
   │      remove the raw token from the caller's AuthInfo    │
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
| Raw token removed before handlers | `http.ts` | The MCP spec forbids passing a client's token to other APIs. Handlers never see it, so they can't pass it on by mistake |
| `defineTool` / `defineResource` / `definePrompt` | `primitives.ts` | One error policy for every handler. Unexpected errors are logged with a reference, and the client sees only the reference |
| Validated configuration | `config.ts` | Wrong settings stop startup with a list of every problem, instead of failing on the first request |
| Structured, redacting logger | `logger.ts` | JSON lines that Workers Logs indexes. Tokens and keys are removed from keys and values |
| Bun `idleTimeout` | `bun.ts` | Bun's 10 s default drops SSE streams that go quiet between progress updates |

## Decisions

**A fresh `McpServer` per request.** `createMcpHandler` calls the factory in `src/server.ts` for every HTTP request, as the SDK requires since 2.3.0. Building a server is cheap (tool schemas are converted lazily), so the factory just registers definitions. Anything expensive, such as API clients or connection pools, belongs in `deps`, which is built once.

**Stateless.** Protocol 2026-07-28 has no sessions; each request carries its own metadata. 2025-era clients are served through the SDK's stateless fallback (`MCP_LEGACY_MODE=stateless`), which means they can't receive server-to-client requests mid-call. `confirm-action` shows what they get instead. Set `MCP_LEGACY_MODE=reject` to serve 2026-07-28 clients only.

**Dependencies are passed in, not imported.** `Deps` in `src/server.ts` holds config, the logger and service clients. Every handler receives it as its last argument. Tests swap in fakes (`tests/helpers.ts`); nothing reads globals.

**Services know nothing about MCP.** `src/services/weather.ts` takes an `AbortSignal`, validates responses, and throws `UpstreamError`. The tool decides what the model is told. Services get their credentials from `Config`, never from the caller's token.

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
