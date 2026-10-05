import { createMcpHandler, type McpServerFactory } from '@modelcontextprotocol/server';
import type { Hono } from 'hono';
import { createDeps, createServer, createVerifier, type Deps, serverInfo } from '../server';
import { createAuth } from './auth';
import type { Config } from './config';
import { createHttpApp } from './http';
import { createLogger } from './logger';

/** The whole server as one fetch handler. Bun and Workers both serve exactly this. */
export interface App {
  fetch(request: Request): Promise<Response>;
  /** Abort in-flight MCP requests. Call after the server stops accepting connections. */
  close(): Promise<void>;
}

export interface AppOptions {
  /** Replace the default dependencies, for example with fakes in tests. */
  deps?: Deps;
  /** Replace the server factory from `src/server.ts`. The template's own tests use this. */
  server?: (deps: Deps) => McpServerFactory;
  /** Replace `routes` from `src/server.ts`. The template's own tests use this. */
  routes?: (app: Hono, deps: Deps) => void;
}

/** Composition root: config in, app out. Everything is wired here and nowhere else. */
export function createApp(config: Config, options: AppOptions = {}): App {
  const deps = options.deps ?? createDeps(config, createLogger(config.logLevel));
  const { logger } = deps;
  const factory = (options.server ?? createServer)(deps);

  // Build one server now, so a registration mistake (a duplicate name, an invalid schema)
  // stops startup instead of failing every request.
  factory({ era: 'modern' });

  const mcp = createMcpHandler(factory, {
    legacy: config.legacy,
    maxRequestBodySize: config.maxRequestBytes,
    // Requests the SDK refused (malformed headers or bodies, unsupported protocol versions)
    // and responses it couldn't finish, usually because the client went away. Failures inside
    // tools, resources and prompts are logged at error level by their error policy.
    onerror: (error) => logger.warning('MCP request failed', { error }),
  });

  const auth =
    config.auth.mode === 'oauth'
      ? createAuth(config, config.auth, createVerifier(config.auth, deps), serverInfo.title)
      : undefined;

  if (!auth && config.environment === 'production') {
    logger.warning('Authentication is off: anyone who can reach this URL can call every tool');
  }

  const http = createHttpApp({
    config,
    mcp,
    auth,
    deps,
    ...(options.routes && { addRoutes: options.routes }),
  });
  return {
    fetch: async (request) => http.fetch(request),
    close: () => mcp.close(),
  };
}
