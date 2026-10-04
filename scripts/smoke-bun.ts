import { parseConfig } from '../src/config/env.js';
import { buildHttpApp, type HttpRuntime } from '../src/http/app.js';
import { smokeClient } from './smoke-client.js';

let runtime: HttpRuntime | undefined;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (request) => runtime?.fetch(request) ?? new Response(null, { status: 503 }),
});
const endpoint = new URL(`http://127.0.0.1:${server.port}/mcp`);
let timeout: ReturnType<typeof setTimeout> | undefined;
try {
  runtime = buildHttpApp(
    parseConfig({
      NODE_ENV: 'test',
      MCP_PUBLIC_URL: endpoint.href,
      MCP_ALLOWED_HOSTS: '127.0.0.1',
      MCP_ALLOWED_ORIGIN_HOSTNAMES: '127.0.0.1',
      MCP_MAX_REQUEST_BYTES: '1024',
      AUTH_ENABLED: 'false',
    }),
    { runtimeName: 'bun' },
  );
  await Promise.race([
    smokeClient(endpoint, 'bun'),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Bun smoke timed out')), 30_000);
    }),
  ]);
} finally {
  clearTimeout(timeout);
  await runtime?.close();
  await server.stop(true);
}
