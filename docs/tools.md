# Tools, resources and prompts

Each tool, resource and prompt is one file. Each folder's `index.ts` lists them. `src/server.ts` registers every listed item on each request's server.

## Define

`defineTool`, `defineResource` and `definePrompt` (in `src/platform/primitives.ts`) take exactly the arguments of the SDK's `server.registerTool`, `registerResource` and `registerPrompt`. They add two things:

1. **`deps` as the handler's last argument**: `(args, ctx, deps)`, `(ctx, deps)`, `(uri, ctx, deps)` or `(uri, variables, ctx, deps)`.
2. **The error policy**, described below.

So any example from the [SDK's server docs](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/docs/servers) works here. Replace `server.registerTool(` with `defineTool(` and add the definition to the list.

`description` is required. It's how the model decides when to call a tool, so say what the tool returns and when to use it.

## Annotations

Annotations tell clients how careful to be with a tool. Set the ones that apply:

| Hint | Set when |
|---|---|
| `readOnlyHint: true` | The tool changes nothing. The other three hints then don't apply |
| `destructiveHint: false` | It changes things, but only adds; nothing is deleted or overwritten |
| `idempotentHint: true` | Calling it twice with the same arguments has the same effect as calling it once |
| `openWorldHint: false` | It only touches this server's own data, not the outside world |

## Errors

There are three kinds of failure, and each reaches a different audience:

| Situation | What to do | Who sees what |
|---|---|---|
| Expected, and the model can act on it: not found, bad input, upstream down | `return toolError('No place named "X". Add the country.')` | The model reads your message. Put the fix in it |
| A resource or prompt request that is wrong | `throw new ResourceNotFoundError(uri.href)` or `throw new ProtocolError(code, message)` | The client gets a JSON-RPC error |
| Anything else thrown: a bug, an unexpected upstream response | Nothing. Let it throw | Logged at `error` with a reference. The client sees only the reference |

That last row is the policy. Without it, the SDK would send the exception's message to the client, and messages often contain upstream URLs, keys or response bodies. `get-forecast` shows all three cases: an unknown city, a weather service outage, and a response that fails validation.

Input that fails `inputSchema` never reaches your handler. The SDK returns a tool error naming the invalid fields.

## Progress and cancellation

```ts
await reportProgress(ctx, 1, 2, 'Found Kraków');            // sent only if the client asked
await fetch(url, { signal: ctx.mcpReq.signal });           // stops when the call is cancelled
```

Pass `ctx.mcpReq.signal` to every I/O call: `fetch`, database queries, SDKs that accept an `AbortSignal`. When a call is cancelled, the SDK aborts the signal, discards the result, and the error policy logs nothing.

## Asking the user

Protocol 2026-07-28 replaces mid-call requests with `input_required`. The handler returns a question; the client asks the user and calls the tool again with the answer:

```ts
if (inputResponse(ctx.mcpReq.inputResponses, 'approval').kind === 'missing') {
  return inputRequired({ inputRequests: { approval: inputRequired.elicit({ message, requestedSchema }) } });
}
const answer = acceptedContent(ctx.mcpReq.inputResponses, 'approval', Approval);
```

Nothing is kept on the server between the two calls. To carry state from one round to the next, use the SDK's `requestState` codec. 2025-era clients over stateless HTTP can't be asked; they receive a tool error and nothing runs. See `src/tools/confirm-action.ts` and the SDK's [input_required guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/input-required.md).

## Scopes

With OAuth on, `OAUTH_SCOPES` lists the scopes every request needs. A tool that needs more declares it:

```ts
scopeChallenge: requireScopes('actions:write'),
```

A caller without that scope gets `403 insufficient_scope` naming the missing scope, before your handler runs. Their client can then ask the user to grant more access. Resources and prompts accept `scopeChallenge` too. With authentication off, scope checks are skipped.

## Calling other APIs

Put the client in `src/services/` and add it to `Deps` in `src/server.ts`:

- Take an `AbortSignal`, and add a timeout of your own (`AbortSignal.any`).
- Validate responses with a schema. A response that doesn't match is a bug to fix, not an outage.
- Throw a typed error, like `UpstreamError`, for outages, so tools can tell them apart from bugs.
- Read API keys from `Config`. Add the variable to `src/platform/config.ts`. On Workers, store it with `wrangler secret put`.
- Never use the caller's token, `ctx.http.authInfo.token`. The template removes it, because the MCP spec forbids passing it on.

If a tool fetches URLs, only fetch from a fixed list or a fixed host. A tool that fetches any URL a client supplies lets anyone make requests from your server's network.

## Prompts

Prompt arguments are always strings when they reach the server. Use `z.string()` and `z.enum([...])`; an argument typed as a boolean or number can't be set by any client. Make optional arguments `.optional()`, and say in the description what happens when one is left out.

## Testing

`tests/helpers.ts` connects an SDK client to `createServer` in process, the way the SDK's [testing guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/testing.md) recommends. No port and no HTTP shell are involved:

```ts
afterEach(cleanup);

test('adds', async () => {
  const client = await connect();
  const result = await client.callTool({ name: 'add', arguments: { a: 2, b: 3 } });
  expect(result.structuredContent).toEqual({ sum: 5 });
});
```

`connect({ deps: testDeps({ weather: fakeWeather({ … }) }) })` replaces services with fakes. `connect({ authInfo })` calls as a specific caller, and `connect({ era: 'legacy' })` as a 2025-era client. `testDeps().logs` records what was logged.

`tests/http.test.ts`, `auth.test.ts` and `sdk-contract.test.ts` test the template itself. Adding or removing tools doesn't affect them.
