import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { serve } from '../src/bun';
import { createApp } from '../src/platform/app';
import { parseConfig } from '../src/platform/config';
import { createLogger } from '../src/platform/logger';
import { createDeps } from '../src/server';
import { smoke } from './smoke-client';

/**
 * Once a tool reports progress its response is an SSE stream, and Bun's default idle
 * timeout (10 s, enforced within a few seconds) drops a stream that stays quiet longer.
 * 15 s is past that window, so this check fails reliably without the fix in src/bun.ts.
 */
const QUIET_MS = 15_000;

const config = parseConfig({
  NODE_ENV: 'test',
  PORT: '0',
  MCP_PUBLIC_URL: 'http://127.0.0.1/mcp',
  MCP_MAX_REQUEST_BYTES: '1024',
});
const deps = createDeps(config, createLogger('warning'));
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

const app = createApp(config, { deps });
const server = serve(config, app);
const endpoint = new URL('/mcp', server.url);

try {
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
} finally {
  await app.close();
  await server.stop(true);
}
