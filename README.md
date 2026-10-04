# MCP Server Template

A remote [Model Context Protocol](https://modelcontextprotocol.io) server for **Bun** and **Cloudflare Workers**, built on the official [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk). It speaks protocol `2026-07-28`, still serves 2025-era clients, and ships with production defaults: Host and Origin checks, OAuth resource-server auth, an error policy that keeps internals out of responses, and tests that run on both runtimes.

The sample server answers weather questions with [Open-Meteo](https://open-meteo.com), which needs no API key, so everything works on the first run. Replace the samples with your own tools; the rest of the template stays.

## Quick start

Requires [Bun](https://bun.sh) 1.4 or newer.

```sh
bun install
bun run dev
```

The server listens on `http://127.0.0.1:3000/mcp`. To run it in Cloudflare's local runtime instead, use `bun run dev:worker`; it listens on `http://127.0.0.1:8787/mcp`.

## Connect a client

| Client | How |
|---|---|
| MCP Inspector | `bun run inspector`, choose **Streamable HTTP**, enter the URL |
| Claude Code | `claude mcp add --transport http weather http://127.0.0.1:3000/mcp` |
| VS Code | Add `{ "servers": { "weather": { "type": "http", "url": "http://127.0.0.1:3000/mcp" } } }` to `.vscode/mcp.json` |
| Cursor | Add `{ "mcpServers": { "weather": { "url": "http://127.0.0.1:3000/mcp" } } }` to `~/.cursor/mcp.json` |

Then ask: *"What's the weather in Kraków this week?"*

## What's inside

Each sample shows one pattern you'll need.

| Sample | Kind | Shows |
|---|---|---|
| `get-forecast` | tool | Calling an upstream API through a service: cancellation, progress, errors the model can recover from |
| `echo` | tool | The smallest complete tool: input and output schemas, annotations |
| `whoami` | tool | Reading the verified caller |
| `confirm-action` | tool | Asking the user mid-call (`input_required`) and requiring an OAuth scope for one tool |
| `docs://server/guide` | resource | A static resource |
| `weather://codes/{code}` | resource template | Listing, reading and completing templated URIs |
| `weather-briefing` | prompt | Prompt arguments and argument completion |

## Project layout

```
src/
  server.ts       Server identity, dependencies, and the per-request McpServer factory
  tools/          ┐
  resources/      │ Your code. One file per tool, resource or prompt;
  prompts/        │ each folder's index.ts lists them.
  services/       ┘ Clients for the APIs your tools call
  platform/       The template: config, HTTP pipeline, auth, logging, defineTool and friends
  bun.ts          Bun entry point
  worker.ts       Cloudflare Workers entry point
tests/            In-process tests per tool, plus HTTP, auth, config and SDK contract suites
scripts/          Smoke tests on real sockets, and a local token issuer
```

You edit `src/server.ts` and the four folders under it. `platform/` is the part you take from the template; changing it should rarely be necessary.

## Add a tool

```ts
// src/tools/add.ts
import * as z from 'zod/v4';
import { defineTool } from '../platform/primitives';

export const add = defineTool(
  'add',
  {
    description: 'Add two numbers.',
    inputSchema: z.object({ a: z.number(), b: z.number() }),
    outputSchema: z.object({ sum: z.number() }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  ({ a, b }) => ({
    content: [{ type: 'text', text: String(a + b) }],
    structuredContent: { sum: a + b },
  }),
);
```

Add it to the list in `src/tools/index.ts`, and add `tests/tools/add.test.ts` (copy `echo.test.ts`). `defineTool` takes the same arguments as the SDK's `server.registerTool`, adds your dependencies as the handler's last argument, and logs unexpected errors instead of showing them to the model. [docs/tools.md](docs/tools.md) covers errors, progress, cancellation, asking the user, scopes and testing.

## Choose a runtime

| | Bun | Cloudflare Workers |
|---|---|---|
| Run locally | `bun run dev` | `bun run dev:worker` |
| Configure with | `.env` (see `.env.example`) | `wrangler.jsonc` vars, `.dev.vars` for local secrets |
| Deploy | Any host that runs Bun, behind HTTPS | `bun run deploy` |
| Good for | Long-running work, local processes, your own infrastructure | Zero-ops global hosting |

The same app runs on both; only the entry point differs. See [docs/deploy.md](docs/deploy.md).

## Configuration

Server identity (name, version, instructions) lives in `src/server.ts`. Deployment settings come from the environment:

| Variable | Default | Purpose |
|---|---|---|
| `MCP_PUBLIC_URL` | `http://127.0.0.1:$PORT/mcp` | Public URL of the endpoint. Required in production |
| `MCP_ALLOWED_HOSTS` | Public URL's host (+ loopback outside production) | Accepted `Host` headers |
| `MCP_ALLOWED_ORIGIN_HOSTNAMES` | Same as hosts | Accepted browser `Origin` headers |
| `AUTH_MODE` | `none` | `none` or `oauth`. Required in production |
| `OAUTH_*` | | Your authorization server; see [docs/auth.md](docs/auth.md) |
| `MCP_LEGACY_MODE` | `stateless` | `reject` to serve 2026-07-28 clients only |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warning` or `error` |

`.env.example` documents every variable. Invalid configuration stops the server at startup with a list of every problem.

## Authentication

With `AUTH_MODE=oauth`, the server is an OAuth resource server. It publishes the metadata clients use to find your authorization server, then accepts only tokens issued for this server's URL. To try it without an authorization server, run `bun run token`: it starts a local key server and prints a token and the settings to use. [docs/auth.md](docs/auth.md) covers real providers and per-tool scopes.

## Scripts

| Script | Does |
|---|---|
| `bun run dev` / `dev:worker` | Run locally on Bun / in Cloudflare's local runtime |
| `bun run check` | Typecheck, lint, test, and check generated Worker types. CI runs this |
| `bun run test:smoke` | Run the real server on Bun and on workerd, and drive it over sockets (needs Node 22.18+) |
| `bun run inspector` | Open MCP Inspector |
| `bun run token` | Start a local authorization server and print a dev token |
| `bun run deploy` | Deploy to Cloudflare with the `production` settings in `wrangler.jsonc` |
| `bun run types:worker` | Regenerate Worker types after changing `wrangler.jsonc` |

## Documentation

- [docs/architecture.md](docs/architecture.md): how a request flows, and why each layer exists
- [docs/tools.md](docs/tools.md): writing and testing tools, resources and prompts
- [docs/auth.md](docs/auth.md): OAuth, scopes and custom token verification
- [docs/deploy.md](docs/deploy.md): Cloudflare Workers and Bun in production
- [docs/troubleshooting.md](docs/troubleshooting.md): common errors and what they mean
- [CHANGELOG.md](CHANGELOG.md): template releases and the SDK version each was verified against

## License

[MIT](LICENSE)
