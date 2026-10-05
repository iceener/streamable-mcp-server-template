import { type App, createApp } from './platform/app';
import { type Config, parseConfig } from './platform/config';
import { createLogger } from './platform/logger';

/**
 * Bun drops a connection that stays quiet for `idleTimeout` seconds (default 10). A tool that
 * reports progress answers with an SSE stream, and it may go quiet for longer than that
 * between updates; the default would cut the call off with no result. 255 is Bun's maximum.
 * `bun run test:smoke` holds such a stream quiet for 15 s to keep this fixed.
 */
const IDLE_TIMEOUT_SECONDS = 255;

/** How long a shutdown waits for in-flight requests before aborting them. */
const DRAIN_TIMEOUT_MS = 10_000;

export function serve(config: Config, app: App): Bun.Server<undefined> {
  return Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: IDLE_TIMEOUT_SECONDS,
    fetch: (request) => app.fetch(request),
  });
}

if (import.meta.main) {
  const config = parseConfig(Bun.env);
  const logger = createLogger(config.logLevel);
  const app = createApp(config, { runtime: {} });
  const server = serve(config, app);

  logger.info('MCP server listening', {
    url: config.publicUrl.href,
    listening: server.url.href,
    auth: config.auth.mode,
  });

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    logger.info('Shutting down', { signal });

    // Stop accepting connections and let in-flight requests finish, up to a limit.
    await Promise.race([server.stop(), Bun.sleep(DRAIN_TIMEOUT_MS)]);
    await app.close();
    await server.stop(true);
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
