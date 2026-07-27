import {
  type AuthInfo,
  type OAuthTokenVerifier,
  oauthMetadataResponse,
  type ServerEventBus,
  type ServerNotifier,
} from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import type { AppConfig } from '../config/env.js';
import { SERVER_ICON_SVG } from '../config/metadata.js';
import { createMcpRuntime } from '../core/runtime.js';
import { sharedLogger as logger } from '../shared/utils/logger.js';
import { createAuthServices } from './auth.js';
import { boundedMcpRequest } from './body.js';
import {
  corsPreflightResponse,
  requestSecurityResponse,
  withCors,
} from './security.js';

export interface HttpRuntimeOptions {
  runtimeName: string;
  verifier?: OAuthTokenVerifier;
  eventBus?: ServerEventBus;
}

export interface HttpRuntime {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
  notify: ServerNotifier;
}

/** Build the fetch-native HTTP shell shared by Bun and Cloudflare Workers. */
export function buildHttpApp(
  config: AppConfig,
  options: HttpRuntimeOptions,
): HttpRuntime {
  logger.setLevel(config.LOG_LEVEL);

  const mcp = createMcpRuntime(config, {
    runtimeName: options.runtimeName,
    ...(options.eventBus ? { eventBus: options.eventBus } : {}),
  });
  const auth = createAuthServices(config, options.verifier);
  const mcpPath = config.MCP_PUBLIC_URL.pathname;
  const app = new Hono();

  app.use('*', async (context, next) => {
    const request = context.req.raw;
    const rejected = requestSecurityResponse(request, config);
    if (rejected) return rejected;

    if (auth) {
      const metadata = oauthMetadataResponse(request, auth.metadata);
      if (metadata) return metadata;
    }

    await next();
  });

  app.get('/health', (context) =>
    context.json({
      status: 'ok',
      runtime: options.runtimeName,
      protocol: '2026-07-28',
      legacyMode: config.MCP_LEGACY_MODE,
      authEnabled: config.AUTH_ENABLED,
      timestamp: new Date().toISOString(),
    }),
  );

  app.get(
    '/icon.svg',
    () =>
      new Response(SERVER_ICON_SVG, {
        headers: {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
          'Content-Security-Policy': "default-src 'none'; style-src 'none'; sandbox",
        },
      }),
  );

  app.options(mcpPath, (context) => corsPreflightResponse(context.req.raw));

  app.all(mcpPath, async (context) => {
    const request = context.req.raw;
    let authInfo: AuthInfo | undefined;
    if (auth) {
      const authResult = await auth.gate(request);
      if (authResult instanceof Response) {
        return withCors(request, authResult);
      }
      authInfo = authResult;
    }

    const bounded = await boundedMcpRequest(request, config.MCP_MAX_REQUEST_BYTES);
    if (bounded.rejection) return withCors(request, bounded.rejection);

    const response = await mcp.fetch(
      bounded.request,
      authInfo ? { authInfo } : undefined,
    );
    return withCors(request, response);
  });

  app.notFound((context) => context.text('Not Found', 404));

  return {
    fetch: async (request) => app.fetch(request),
    close: mcp.close,
    notify: mcp.notify,
  };
}
