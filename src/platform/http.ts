import {
  type AuthInfo,
  hostHeaderValidationResponse,
  type McpHttpHandler,
  originValidationResponse,
} from '@modelcontextprotocol/server';
import { Hono, type MiddlewareHandler } from 'hono';
import { SERVER_ICON_PATH, SERVER_ICON_SVG, serverInfo } from '../server';
import type { Auth } from './auth';
import type { Config } from './config';
import { corsPreflight, withCors } from './cors';
import type { Logger } from './logger';

export interface HttpOptions {
  config: Config;
  mcp: McpHttpHandler;
  auth: Auth | undefined;
  logger: Logger;
}

/**
 * The HTTP pipeline in front of the SDK handler, in this order:
 *
 *  1. Host check on every route: DNS-rebinding protection.
 *  2. OAuth discovery documents: public, readable from any origin.
 *  3. Origin check on everything else.
 *  4. The MCP endpoint: CORS preflight, bearer gate, then the SDK handler.
 *
 * Add your own routes (webhooks, OAuth callbacks) here; they inherit steps 1 and 3.
 */
export function createHttpApp({ config, mcp, auth, logger }: HttpOptions): Hono {
  const app = new Hono();
  const mcpPath = config.publicUrl.pathname;

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

    const response = await mcp.fetch(
      request,
      caller ? { authInfo: withoutToken(caller) } : undefined,
    );
    return withCors(request, response);
  });

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
 * Handlers get the verified caller without the raw bearer token. That token was issued
 * for this server; passing it to another API is forbidden by the MCP specification, and
 * leaving it out makes that impossible rather than merely discouraged.
 */
export function withoutToken(caller: AuthInfo): AuthInfo {
  return { ...caller, token: '' };
}
