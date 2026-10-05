import {
  hostHeaderValidationResponse,
  type McpHttpHandler,
  originValidationResponse,
} from '@modelcontextprotocol/server';
import { Hono, type MiddlewareHandler } from 'hono';
import { type Deps, routes, SERVER_ICON_PATH, SERVER_ICON_SVG, serverInfo } from '../server';
import type { Auth } from './auth';
import type { Config } from './config';
import { corsPreflight, withCors } from './cors';

export interface HttpOptions {
  config: Config;
  mcp: McpHttpHandler;
  auth: Auth | undefined;
  deps: Deps;
  /** Defaults to `routes` from `src/server.ts`. */
  addRoutes?: (app: Hono, deps: Deps) => void;
}

/**
 * The HTTP pipeline in front of the SDK handler, in this order:
 *
 *  1. Host check on every route: DNS-rebinding protection.
 *  2. OAuth discovery documents: public, readable from any origin.
 *  3. Origin check on everything else.
 *  4. The MCP endpoint: CORS preflight, bearer gate, then the SDK handler.
 *
 * Your own routes come from `routes` in `src/server.ts`; they inherit steps 1 and 3.
 */
export function createHttpApp({ config, mcp, auth, deps, addRoutes = routes }: HttpOptions): Hono {
  const { logger } = deps;
  const app = new Hono();
  const mcpPath = config.publicUrl.pathname;

  // One line per request at debug level. Workers Logs records requests on its own.
  app.use(async (c, next) => {
    const started = performance.now();
    await next();
    logger.debug('HTTP request', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round(performance.now() - started),
      mcpMethod: c.req.header('Mcp-Method'),
      mcpName: c.req.header('Mcp-Name'),
    });
  });

  app.use(guard((request) => hostHeaderValidationResponse(request, config.allowedHosts)));
  if (auth) app.use(guard(auth.metadata));
  app.use(guard((request) => originValidationResponse(request, config.allowedOrigins)));

  app.get('/health', (c) =>
    c.json({ status: 'ok', name: serverInfo.name, version: serverInfo.version }),
  );

  app.get(
    SERVER_ICON_PATH,
    () =>
      new Response(SERVER_ICON_SVG, {
        headers: {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
          'Content-Security-Policy': "default-src 'none'; sandbox",
        },
      }),
  );

  app.options(mcpPath, (c) => corsPreflight(c.req.raw));

  app.all(mcpPath, async (c) => {
    const request = c.req.raw;
    const caller = auth ? await auth.gate(request) : undefined;
    if (caller instanceof Response) return withCors(request, caller);

    const response = caller
      ? await mcp.fetch(withoutCredentials(request), { authInfo: { ...caller, token: '' } })
      : await mcp.fetch(request);
    return withCors(request, response);
  });

  // After the MCP endpoint, so nothing added here can run before its bearer token check.
  addRoutes(app, deps);

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  app.onError((error, c) => {
    logger.error('Unhandled HTTP error', { error, method: c.req.method, path: c.req.path });
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}

/** Run a check that either answers the request or lets it continue. */
function guard(check: (request: Request) => Response | undefined): MiddlewareHandler {
  return async (c, next) => check(c.req.raw) ?? (await next());
}

/**
 * Once the token is verified, handlers get the caller (`ctx.http.authInfo`) but never the
 * credential: the token is blanked there, and the `Authorization` header is removed from
 * the request they can read as `ctx.http.req`. The token was issued for this server only,
 * and the MCP specification forbids passing it to another API.
 */
function withoutCredentials(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete('Authorization');
  return new Request(request, { headers });
}
