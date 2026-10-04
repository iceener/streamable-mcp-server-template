import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { unstable_startWorker } from 'wrangler';

/**
 * Run the real Worker in local workerd and drive it with the shared smoke client.
 * Wrangler's API needs Node, so this file runs under Node; the client runs under Bun.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const plain = (value: string) => ({ type: 'plain_text' as const, value });

process.env.WRANGLER_SEND_METRICS = 'false';
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';

const worker = await unstable_startWorker({
  config: `${root}wrangler.jsonc`,
  bindings: {
    NODE_ENV: plain('test'),
    MCP_PUBLIC_URL: plain('http://127.0.0.1/mcp'),
    MCP_MAX_REQUEST_BYTES: plain('1024'),
    AUTH_MODE: plain('none'),
  },
  dev: {
    server: { hostname: '127.0.0.1', port: 0 },
    inspector: false,
    watch: false,
    logLevel: 'warn',
  },
});

try {
  const url = await worker.url;
  const { stdout, stderr } = await promisify(execFile)(
    'bun',
    [`${root}scripts/smoke-client.ts`, new URL('/mcp', url).href, 'workers'],
    { cwd: root, timeout: 60_000 },
  );
  process.stdout.write(stdout);
  process.stderr.write(stderr);
} finally {
  await worker.dispose();
}
