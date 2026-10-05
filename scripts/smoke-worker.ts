import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { unstable_startWorker } from 'wrangler';
// Node runs this file directly, so the import names the .ts file.
import { TEST_SETTINGS } from '../tests/settings.ts';

/**
 * Run the real Worker in local workerd: once in OAuth mode against a loopback key server,
 * driven by the shared smoke client; once misconfigured, to check it fails safely.
 * Wrangler's API needs Node, so this file runs under Node; the client runs under Bun.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const plain = (value: string) => ({ type: 'plain_text' as const, value });
const PUBLIC_URL = 'http://127.0.0.1/mcp';

process.env.WRANGLER_SEND_METRICS = 'false';
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';

function startWorker(vars: Record<string, string>, logLevel: 'warn' | 'none' = 'warn') {
  return unstable_startWorker({
    config: `${root}wrangler.jsonc`,
    bindings: Object.fromEntries(Object.entries(vars).map(([name, value]) => [name, plain(value)])),
    dev: {
      server: { hostname: '127.0.0.1', port: 0 },
      inspector: false,
      watch: false,
      logLevel,
    },
  });
}

// A key server standing in for the authorization server.
const { privateKey, publicKey } = await generateKeyPair('ES256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'smoke', alg: 'ES256', use: 'sig' };
const keyServer = createServer((_request, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ keys: [jwk] }));
});
await new Promise<void>((resolve) => keyServer.listen(0, '127.0.0.1', resolve));
const issuer = `http://127.0.0.1:${(keyServer.address() as AddressInfo).port}`;

const token = await new SignJWT({ client_id: 'smoke', scope: 'mcp' })
  .setProtectedHeader({ alg: 'ES256', kid: 'smoke' })
  .setIssuer(issuer)
  .setAudience(PUBLIC_URL)
  .setIssuedAt()
  .setExpirationTime('5m')
  .sign(privateKey);

const worker = await startWorker({
  ...TEST_SETTINGS,
  NODE_ENV: 'test',
  MCP_PUBLIC_URL: PUBLIC_URL,
  MCP_MAX_REQUEST_BYTES: '1024',
  AUTH_MODE: 'oauth',
  OAUTH_ISSUER_URL: issuer,
  OAUTH_AUTHORIZATION_URL: `${issuer}/authorize`,
  OAUTH_TOKEN_URL: `${issuer}/token`,
  OAUTH_JWKS_URL: `${issuer}/jwks.json`,
  OAUTH_SCOPES: 'mcp',
});
try {
  const endpoint = new URL('/mcp', await worker.url).href;
  const { stdout, stderr } = await promisify(execFile)(
    'bun',
    [`${root}scripts/smoke-client.ts`, endpoint, 'workers', token],
    { cwd: root, timeout: 60_000 },
  );
  process.stdout.write(stdout);
  process.stderr.write(stderr);
} finally {
  await worker.dispose();
  keyServer.close();
}

// Production settings with the auth decision missing: every request gets a generic 500.
// Its configuration error is the point here, so keep it out of the output.
const misconfigured = await startWorker(
  { NODE_ENV: 'production', MCP_PUBLIC_URL: 'https://mcp.example.com/mcp', AUTH_MODE: '' },
  'none',
);
try {
  const response = await fetch(new URL('/health', await misconfigured.url));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'server_misconfigured' });
  console.info('workers: invalid configuration answers a generic 500');
} finally {
  await misconfigured.dispose();
}
