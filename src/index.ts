import { parseConfig } from './config/env.js';
import { buildHttpApp } from './http/app.js';
import { sharedLogger as logger } from './shared/utils/logger.js';

const config = parseConfig(process.env);
const runtime = buildHttpApp(config, { runtimeName: 'bun' });
const server = Bun.serve({
  hostname: config.HOST,
  port: config.PORT,
  fetch: (request) => runtime.fetch(request),
});

logger.info('server', {
  message: 'MCP server started',
  url: config.MCP_PUBLIC_URL.href,
  protocol: '2026-07-28',
  legacyMode: config.MCP_LEGACY_MODE,
  authEnabled: config.AUTH_ENABLED,
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info('server', { message: 'Shutting down', signal });
  const gracefulStop = server.stop(false);
  await runtime.close();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const stopped = await Promise.race([
    gracefulStop.then(() => true),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), 5_000);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (!stopped) await server.stop(true);
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});
