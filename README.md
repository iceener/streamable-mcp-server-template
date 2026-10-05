# MCP Server Template

This template is a remote [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server. It runs on **Bun** and on **Cloudflare Workers**. It uses the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

The server uses protocol version `2026-07-28`. It also accepts clients that use the 2025 protocol versions.

The template includes these functions:

- Checks of the `Host` and `Origin` headers.
- OAuth token checks. The server is an OAuth resource server. Your code does not receive the token.
- An error policy. The server does not send internal error data to clients.
- Tests that run on Bun and on Cloudflare Workers.

The sample server gives weather data from [Open-Meteo](https://open-meteo.com). Open-Meteo does not require an API key. Replace the samples with your tools. Keep the other parts of the template.

## Requirements

- [Bun](https://bun.sh) 1.4 or later.
- Node.js 22.18 or later. The Wrangler commands and the smoke tests use Node.js.

## Start the server

1. Install the dependencies:

   ```sh
   bun install
   ```

2. Start the server:

   ```sh
   bun run dev
   ```

The server URL is `http://127.0.0.1:3000/mcp`.

To use the Cloudflare local runtime, run `bun run dev:worker`. The server URL is then `http://127.0.0.1:8787/mcp`.

## Connect a client

Use the server URL and the Streamable HTTP transport.

| Client | Procedure |
|---|---|
| MCP Inspector | Run `bun run inspector`. Select **Streamable HTTP**. Enter the server URL. |
| Claude Code | Run `claude mcp add --transport http weather http://127.0.0.1:3000/mcp`. |
| VS Code | Add `{ "servers": { "weather": { "type": "http", "url": "http://127.0.0.1:3000/mcp" } } }` to `.vscode/mcp.json`. |
| Cursor | Add `{ "mcpServers": { "weather": { "url": "http://127.0.0.1:3000/mcp" } } }` to `~/.cursor/mcp.json`. |

To test the connection, send a request. For example: *"What is the weather in Kraków this week?"*

## Samples

Each sample shows one procedure.

| Sample | Type | Shows |
|---|---|---|
| `get-forecast` | Tool | A call to an external API through a service. It shows cancellation, progress, and errors that the model can correct. |
| `echo` | Tool | The smallest complete tool: an input schema, an output schema, and annotations. |
| `whoami` | Tool | How to read the identity of the verified caller. |
| `confirm-action` | Tool | How to ask the user for approval during a call (`input_required`). The tool also requires an OAuth scope. |
| `docs://server/guide` | Resource | A static resource. |
| `weather://codes/{code}` | Resource template | How to list, read, and complete URIs from a template. |
| `weather-briefing` | Prompt | Prompt arguments and argument completion. |

## Project structure

```
src/
  server.ts       Server identity, dependencies, token verification, extra routes, McpServer factory
  settings.ts     Settings for your code, for example API keys
  tools/          ┐
  resources/      │ Your code. Each tool, resource, or prompt has one file.
  prompts/        │ The index.ts file in each folder lists them.
  services/       ┘ Clients for the external APIs that your tools use
  platform/       Template code: configuration, HTTP pipeline, authentication, logs, defineTool
  bun.ts          Entry point for Bun
  worker.ts       Entry point for Cloudflare Workers
tests/            Tests for each tool and service, and tests for the platform code
scripts/          Smoke tests on real network sockets, and a local token issuer
```

You change `server.ts`, `settings.ts`, and the four folders. The `platform/` folder is template code. Do not change it unless it is necessary.

`platform/` uses only a fixed set of names from `server.ts` and `settings.ts`. This lets you replace `platform/` with the version from a newer template. `server.ts` has hooks for settings, token verification, and extra HTTP routes.

## Add a tool

1. Create a file in `src/tools/`. For example:

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

2. Add the tool to the list in `src/tools/index.ts`.
3. Create the test file `tests/tools/add.test.ts`. Use `tests/tools/echo.test.ts` as an example.

`defineTool` has the same arguments as `server.registerTool` in the SDK. It also does these tasks:

- It gives your dependencies (`deps`) to the handler as the last argument.
- It makes sure that `structuredContent` agrees with `outputSchema` when you compile the code.
- It records unexpected errors in the log. The model does not see these errors.

For errors, progress, cancellation, user input, scopes, and tests, refer to [docs/tools.md](docs/tools.md).

## Runtimes

| | Bun | Cloudflare Workers |
|---|---|---|
| Start locally | `bun run dev` | `bun run dev:worker` |
| Configuration | `.env` (refer to `.env.example`) | `vars` in `wrangler.jsonc`. Put local secrets in `.dev.vars`. |
| Deployment | A host that runs Bun, behind HTTPS | `bun run deploy` |
| Use it for | Long tasks, local processes, your own servers | Global hosting without server maintenance |

The two runtimes use the same application. Only the entry point is different. For more data, refer to [docs/deploy.md](docs/deploy.md).

## Configuration

The server identity (name, version, and instructions) is in `src/server.ts`. The deployment settings are environment variables:

| Variable | Default | Function |
|---|---|---|
| `MCP_PUBLIC_URL` | `http://127.0.0.1:$PORT/mcp` | The public URL of the endpoint. Production requires it. |
| `MCP_ALLOWED_HOSTS` | The host of the public URL, and the loopback hosts outside production | The `Host` headers that the server accepts |
| `MCP_ALLOWED_ORIGIN_HOSTNAMES` | The host of the public URL, and the loopback hosts outside production | The browser `Origin` headers that the server accepts |
| `AUTH_MODE` | `none` | `none` or `oauth`. Production requires it. |
| `OAUTH_*` | | The settings of your authorization server. Refer to [docs/auth.md](docs/auth.md). |
| `MCP_LEGACY_MODE` | `stateless` | Set `reject` to accept only `2026-07-28` clients. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warning`, or `error` |

Put your own settings, for example API keys, in `src/settings.ts`. The server validates them together with the other settings. The file `.env.example` describes all variables.

If the configuration is not valid, the server shows all problems at the same time:

- Bun does not start.
- A Worker records the problems in the log. It sends a 500 response to all requests until you correct the configuration.

## Authentication

When `AUTH_MODE=oauth`, the server is an OAuth resource server. The server publishes metadata that tells clients where your authorization server is. The server accepts only the tokens that your authorization server issued for this server URL.

To test OAuth without an authorization server, run `bun run token`. This command starts a local key server. It shows a token and the settings to use. For real providers and scopes for each tool, refer to [docs/auth.md](docs/auth.md).

## Scripts

| Script | Function |
|---|---|
| `bun run dev` | Starts the server on Bun. |
| `bun run dev:worker` | Starts the server in the Cloudflare local runtime. |
| `bun run check` | Does the type check, the lint check, and the tests. It also checks the generated Worker types. CI runs this script. |
| `bun run test:smoke` | Starts the real server on Bun and on workerd, and sends requests through network sockets. It requires Node.js 22.18 or later. |
| `bun run inspector` | Starts MCP Inspector. |
| `bun run token` | Starts a local authorization server and shows a test token. |
| `bun run deploy` | Deploys to Cloudflare with the `production` settings in `wrangler.jsonc`. |
| `bun run types:worker` | Makes the Worker types again. Run it after you change `wrangler.jsonc`. |

## Documentation

- [docs/architecture.md](docs/architecture.md): The path of a request through the server, and the function of each layer.
- [docs/tools.md](docs/tools.md): How to write and test tools, resources, and prompts.
- [docs/auth.md](docs/auth.md): OAuth, scopes, and other token checks.
- [docs/deploy.md](docs/deploy.md): Cloudflare Workers and Bun in production.
- [docs/troubleshooting.md](docs/troubleshooting.md): Frequent errors and their causes.
- [CHANGELOG.md](CHANGELOG.md): The template versions, and the SDK version that each version uses.

## License

[MIT](LICENSE)
