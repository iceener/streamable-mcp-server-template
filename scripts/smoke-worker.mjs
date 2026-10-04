import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Wrangler's development API runs in Node, not Bun. Only its local workerd
// listener is used; the official client is a separate Bun process over HTTP.
process.env.WRANGLER_SEND_METRICS = 'false';
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
const { unstable_dev } = await import('wrangler');
const root = fileURLToPath(new URL('../', import.meta.url));
let worker;
try {
  worker = await unstable_dev(`${root}src/worker.ts`, {
    config: `${root}wrangler.jsonc`,
    envFiles: [],
    ip: '127.0.0.1',
    port: 0,
    inspectorPort: 0,
    local: true,
    persist: false,
    logLevel: 'warn',
    vars: {
      NODE_ENV: 'test',
      AUTH_ENABLED: 'false',
      MCP_MAX_REQUEST_BYTES: '1024',
      // Auth-disabled route fixture. The assigned socket port is passed to the
      // client below; external OAuth/resource-origin discovery is not tested.
      MCP_PUBLIC_URL: 'http://127.0.0.1/mcp',
      MCP_ALLOWED_HOSTS: '127.0.0.1',
      MCP_ALLOWED_ORIGIN_HOSTNAMES: '127.0.0.1',
    },
    experimental: {
      disableExperimentalWarning: true,
      disableDevRegistry: true,
      forceLocal: true,
      watch: false,
      liveReload: false,
    },
  });
  const { stdout, stderr } = await promisify(execFile)(
    'bun',
    [`${root}scripts/smoke-client.ts`, `http://127.0.0.1:${worker.port}/mcp`],
    { cwd: root, timeout: 40_000 },
  );
  process.stdout.write(stdout);
  process.stderr.write(stderr);
} finally {
  await worker?.stop();
}
