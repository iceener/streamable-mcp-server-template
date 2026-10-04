import { createMcpHandler, type McpServerFactory } from '@modelcontextprotocol/server';
import { createDeps, createServer, type Deps, serverInfo } from '../server';
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
}

/** Composition root: config in, app out. Everything is wired here and nowhere else. */
export function createApp(config: Config, options: AppOptions = {}): App {
  const deps = options.deps ?? createDeps(config, createLogger(config.logLevel));
  const { logger } = deps;

  const mcp = createMcpHandler((options.server ?? createServer)(deps), {
    legacy: config.legacy,
    maxRequestBodySize: config.maxRequestBytes,
    // Mostly requests the SDK refused (bad headers, wrong media type); faults inside
    // tools are logged at error level by the primitives' error policy.
    onerror: (error) => logger.warning('MCP request failed', { error }),
  });

  const auth =
    config.auth.mode === 'oauth'
      ? createAuth(config, config.auth, serverInfo.title, logger)
      : undefined;

  if (!auth && config.environment === 'production') {
    logger.warning('Authentication is off: anyone who can reach this URL can call every tool');
  }

  const http = createHttpApp({ config, mcp, auth, logger });
  return {
    fetch: async (request) => http.fetch(request),
    close: () => mcp.close(),
  };
}
