# Deploy

Before the first deploy, in either runtime:

- [ ] Rewrite every field of `serverInfo` in `src/server.ts` (name, title, version, description, websiteUrl), the `instructions`, and the worker names in `wrangler.jsonc`.
- [ ] Set `MCP_PUBLIC_URL` to the exact HTTPS URL clients will use. It is also the OAuth audience, so changing it later breaks every issued token.
- [ ] Set `MCP_ALLOWED_HOSTS` to that URL's hostname, and `MCP_ALLOWED_ORIGIN_HOSTNAMES` to it plus any browser-based clients.
- [ ] Choose `AUTH_MODE`. Production won't start without it. `none` means anyone who can reach the URL can call every tool.
- [ ] Run `bun run check && bun run test:smoke`.

## Cloudflare Workers

`wrangler.jsonc` has two sets of variables:

- **Top level**, used by `wrangler dev`. These only accept loopback hosts, so a Worker deployed with them refuses every request.
- **`env.production`**, used by `bun run deploy`. Replace every `example.com` value.

```sh
bunx wrangler login
bun run deploy                       # wrangler deploy --env production
```

On `workers.dev` the URL is `https://<name>.<your-subdomain>.workers.dev/mcp`. To use your own domain, add a [custom domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) route to `env.production` and use that hostname everywhere above.

**Secrets.** Declare API keys in `src/settings.ts`, then store each value with `bunx wrangler secret put NAME --env production`. Never put secrets in `vars`. For local `wrangler dev`, put them in `.dev.vars`; it is gitignored.

**Types.** After you change `wrangler.jsonc`, run `bun run types:worker`. `bun run check` fails while the generated `worker-configuration.d.ts` is out of date.

**Logs.** `observability` is on, and the server logs JSON, so Workers Logs can filter on fields like `level`, `tool` and `reference`. When a client reports `reference 2bcc…`, search for it there.

**Configuration errors.** If the variables are invalid, the Worker logs every problem once and answers `500 {"error":"server_misconfigured"}` until you redeploy. The details stay in the logs, not in responses.

## Bun

Run `bun src/bun.ts` (or `bun run start`) on any host with Bun 1.4 or newer, behind something that terminates HTTPS: a load balancer, Caddy, nginx or a platform router.

```sh
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
MCP_PUBLIC_URL=https://mcp.example.com/mcp
MCP_ALLOWED_HOSTS=mcp.example.com
MCP_ALLOWED_ORIGIN_HOSTNAMES=mcp.example.com
AUTH_MODE=oauth
OAUTH_ISSUER_URL=…
```

- **Proxies** must pass the original `Host` header and must not buffer `text/event-stream` responses. With nginx, set `proxy_buffering off` for `/mcp`.
- **Health checks** call `GET /health`. The Host check covers every route, so send the public hostname: `curl -H 'Host: mcp.example.com' http://127.0.0.1:3000/health`.
- **Shutdown.** On `SIGTERM` the server stops accepting connections, gives requests in progress up to 10 s to finish, then cancels the rest.
- **Several instances** need nothing shared: the server keeps no state between requests.
