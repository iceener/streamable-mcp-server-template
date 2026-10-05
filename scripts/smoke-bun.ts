import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { serve } from '../src/bun';
import { createApp } from '../src/platform/app';
import { parseConfig } from '../src/platform/config';
import { createLogger } from '../src/platform/logger';
import { createDeps, type Deps } from '../src/server';
import { smoke } from './smoke-client';

/**
 * Once a tool reports progress its response is an SSE stream, and Bun's default idle
 * timeout (10 s, enforced within a few seconds) drops a stream that stays quiet longer.
 * 15 s is past that window, so this check fails reliably without the fix in src/bun.ts.
 */
const QUIET_MS = 15_000;
const PUBLIC_URL = 'http://127.0.0.1/mcp';

/** Run the real Bun server on a free port, call `run` with its MCP URL, then stop it. */
async function withServer(
  env: Record<string, string>,
  run: (endpoint: URL) => Promise<void>,
  configure: (deps: Deps) => void = () => {},
): Promise<void> {
  const config = parseConfig({ NODE_ENV: 'test', PORT: '0', MCP_PUBLIC_URL: PUBLIC_URL, ...env });
  const deps = createDeps(config, createLogger('warning'));
  configure(deps);
  const app = createApp(config, { deps });
  const server = serve(config, app);
  try {
    await run(new URL('/mcp', server.url));
  } finally {
    await app.close();
    await server.stop(true);
  }
}

// Authentication off: both protocol eras, the guards, and a long quiet stream.
await withServer(
  { MCP_MAX_REQUEST_BYTES: '1024' },
  async (endpoint) => {
    await smoke(endpoint, 'bun');

    const client = new Client(
      { name: 'smoke', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    const progress: number[] = [];
    const result = await client.callTool(
      { name: 'get-forecast', arguments: { city: 'Slowtown' } },
      { onprogress: (update) => progress.push(update.progress), timeout: 20_000 },
    );
    await client.close();

    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.deepEqual(progress, [1, 2]);
    console.info(`bun: an SSE stream quiet for ${QUIET_MS / 1000} s survived the idle timeout`);
  },
  (deps) => {
    // Finding the place reports progress, which opens the SSE stream; the forecast then goes quiet.
    deps.weather = {
      findPlace: async () => ({
        name: 'Slowtown',
        region: undefined,
        country: 'Nowhere',
        latitude: 0,
        longitude: 0,
        timezone: 'UTC',
      }),
      getForecast: async (place, _days, signal) => {
        await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
        signal.throwIfAborted();
        return {
          place,
          current: {
            time: '2026-10-05T12:00',
            temperatureC: 20,
            feelsLikeC: 20,
            humidityPercent: 50,
            windKmh: 5,
            conditions: 'Clear sky',
          },
          daily: [],
        };
      },
    };
  },
);

// OAuth on: a local key server stands in for the authorization server.
const { privateKey, publicKey } = await generateKeyPair('ES256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'smoke', alg: 'ES256', use: 'sig' };
const keyServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: () => Response.json({ keys: [jwk] }),
});
const issuer = keyServer.url.origin;
const token = await new SignJWT({ client_id: 'smoke', scope: 'mcp' })
  .setProtectedHeader({ alg: 'ES256', kid: 'smoke' })
  .setIssuer(issuer)
  .setAudience(PUBLIC_URL)
  .setIssuedAt()
  .setExpirationTime('5m')
  .sign(privateKey);

try {
  await withServer(
    {
      MCP_MAX_REQUEST_BYTES: '1024',
      AUTH_MODE: 'oauth',
      OAUTH_ISSUER_URL: issuer,
      OAUTH_AUTHORIZATION_URL: `${issuer}/authorize`,
      OAUTH_TOKEN_URL: `${issuer}/token`,
      OAUTH_JWKS_URL: `${issuer}/jwks.json`,
      OAUTH_SCOPES: 'mcp',
    },
    (endpoint) => smoke(endpoint, 'bun (oauth)', token),
  );
} finally {
  await keyServer.stop(true);
}
