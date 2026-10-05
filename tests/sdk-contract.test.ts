import { afterEach, describe, expect, test } from 'bun:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import type { App } from '../src/platform/app';
import { defineTool } from '../src/platform/primitives';
import { FIXTURE } from './fixture';
import { cleanup, message, PUBLIC_URL, post, testApp, testConfig, track } from './helpers';

/**
 * Wire behavior of @modelcontextprotocol/server 2.3.0 that this template relies on.
 * If one of these fails after an SDK upgrade, the SDK changed: read its changelog and
 * update the docs that describe the behavior, not just the assertion.
 */

afterEach(cleanup);

async function expectError(response: Response, status: number, code: number) {
  expect(response.status).toBe(status);
  expect(response.headers.has('Mcp-Session-Id')).toBe(false);
  expect(await response.json()).toMatchObject({ jsonrpc: '2.0', error: { code } });
}

function legacyPost(body: unknown, accept = 'application/json, text/event-stream') {
  return testApp().fetch(
    new Request(PUBLIC_URL, {
      method: 'POST',
      headers: { Host: '127.0.0.1:3000', 'Content-Type': 'application/json', Accept: accept },
      body: JSON.stringify(body),
    }),
  );
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'raw-legacy', version: '1.0.0' },
  },
};

describe('2026-07-28 requests', () => {
  test('server identity travels in result._meta; there is no session', async () => {
    const response = await post(testApp(), message('server/discover'));

    expect(response.status).toBe(200);
    expect(response.headers.has('Mcp-Session-Id')).toBe(false);
    const body = await response.json();
    expect(body).toMatchObject({
      result: {
        _meta: {
          'io.modelcontextprotocol/serverInfo': FIXTURE,
        },
      },
    });
    expect(body).not.toHaveProperty('result.serverInfo');
  });

  test('protocol headers are required and must match the body (since 2.1.0)', async () => {
    const app = testApp();
    await expectError(
      await post(app, message('tools/list'), { 'MCP-Protocol-Version': null }),
      400,
      -32020,
    );
    await expectError(await post(app, message('tools/list'), { 'Mcp-Method': null }), 400, -32020);
    await expectError(
      await post(app, message('tools/list'), { 'Mcp-Method': 'prompts/list' }),
      400,
      -32020,
    );

    const call = message('tools/call', { name: 'probe', arguments: { text: 'x' } });
    await expectError(await post(app, call), 400, -32020);
    expect((await post(app, call, { 'Mcp-Name': 'probe' })).status).toBe(200);
  });

  test('unsupported revisions, malformed metadata and invalid JSON', async () => {
    const app = testApp();
    const future = message('tools/list');
    future.params._meta['io.modelcontextprotocol/protocolVersion'] = '2099-01-01';
    await expectError(
      await post(app, future, { 'MCP-Protocol-Version': '2099-01-01' }),
      400,
      -32022,
    );

    const noCapabilities = message('tools/list');
    Reflect.deleteProperty(
      noCapabilities.params._meta,
      'io.modelcontextprotocol/clientCapabilities',
    );
    await expectError(await post(app, noCapabilities), 400, -32602);

    const invalid = await app.fetch(
      new Request(PUBLIC_URL, {
        method: 'POST',
        headers: {
          Host: '127.0.0.1:3000',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: '{',
      }),
    );
    await expectError(invalid, 400, -32700);
  });

  test('only POST with a JSON body is served', async () => {
    const app = testApp();
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const response = await app.fetch(
        new Request(PUBLIC_URL, { method, headers: { Host: '127.0.0.1:3000' } }),
      );
      expect(response.status).toBe(405);
    }
    await expectError(
      await post(app, message('tools/list'), { 'Content-Type': 'text/plain' }),
      415,
      -32000,
    );
  });
});

describe('2025-era requests', () => {
  test('initialize is served statelessly, with serverInfo at the root', async () => {
    const response = await legacyPost(initialize);

    expect(response.status).toBe(200);
    expect(response.headers.has('Mcp-Session-Id')).toBe(false);
    const data = (await response.text()).split('\n').find((line) => line.startsWith('data: '));
    const body = JSON.parse(data?.slice('data: '.length) ?? 'null');
    expect(body.result.serverInfo).toEqual(FIXTURE);
  });

  test('both Accept media types are required', async () => {
    await expectError(await legacyPost(initialize, 'application/json'), 406, -32000);
  });

  test('a batch over 100 messages is refused whole (since 2.1.0)', async () => {
    const batch = Array.from({ length: 101 }, (_, id) => ({ jsonrpc: '2.0', id, method: 'ping' }));
    await expectError(await legacyPost(batch), 400, -32600);
  });

  test('MCP_LEGACY_MODE=reject turns 2025-era clients away', async () => {
    const app = testApp(testConfig({ MCP_LEGACY_MODE: 'reject' }));
    const response = await app.fetch(
      new Request(PUBLIC_URL, {
        method: 'POST',
        headers: {
          Host: '127.0.0.1:3000',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(initialize),
      }),
    );
    expect(response.status).toBe(400);
  });
});

/**
 * Clients send `MCP-Protocol-Version` on every request after initialize. A server that ignores
 * the header works until a client with a version it doesn't support connects; these tests
 * pin that such a client gets a clean 400 and that nothing runs.
 */
describe('MCP-Protocol-Version header', () => {
  /** An app whose one tool counts its calls, to prove refused requests never reach it. */
  function countingApp() {
    let calls = 0;
    const counted = defineTool('counted', { description: 'Counts its calls.' }, () => {
      calls += 1;
      return { content: [{ type: 'text', text: String(calls) }] };
    });
    const app = testApp(testConfig(), {
      server: (deps) => () => {
        const server = new McpServer(FIXTURE);
        counted.register(server, deps);
        return server;
      },
    });
    return { app, calls: () => calls };
  }

  const callCounted = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'counted', arguments: {} },
  };

  /** A 2025-era request after initialize: no `_meta` envelope, and the version in a header. */
  function post2025(app: App, version?: string) {
    const headers = new Headers({
      Host: '127.0.0.1:3000',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    });
    if (version !== undefined) headers.set('MCP-Protocol-Version', version);
    return app.fetch(
      new Request(PUBLIC_URL, { method: 'POST', headers, body: JSON.stringify(callCounted) }),
    );
  }

  /** The JSON-RPC message in a response, whether it came as JSON or as one SSE event. */
  async function rpcBody(response: Response): Promise<unknown> {
    const text = await response.text();
    const event = text.split('\n').find((line) => line.startsWith('data: '));
    return JSON.parse(event ? event.slice('data: '.length) : text);
  }

  test('2025-era: every version such a client can negotiate is served', async () => {
    const { app, calls } = countingApp();
    for (const version of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']) {
      const response = await post2025(app, version);
      expect(response.status).toBe(200);
      expect(await rpcBody(response)).toMatchObject({
        id: 2,
        result: { content: [{ type: 'text' }] },
      });
    }
    expect(calls()).toBe(5);
  });

  test('2025-era: without the header, the request is served as 2025-03-26', async () => {
    // The spec's rule for clients that predate the header.
    const { app, calls } = countingApp();
    const response = await post2025(app);

    expect(response.status).toBe(200);
    expect(calls()).toBe(1);
  });

  test('2025-era: an unsupported or malformed version gets a clean 400, and nothing runs', async () => {
    const { app, calls } = countingApp();
    // Values the SDK reads as a later revision are refused because the body lacks that
    // revision's per-request envelope (-32602). Any other value fails the 2025 transport's
    // version check (-32000). Either way: a 400 with a JSON-RPC error, before any handler.
    const cases: Array<[string, number]> = [
      ['1999-01-01', -32000],
      ['', -32000],
      ['2099-01-01', -32602],
      ['not-a-version', -32602],
      ['2026-07-28', -32602],
    ];
    for (const [version, code] of cases) {
      const response = await post2025(app, version);
      expect(response.headers.get('Content-Type')).toStartWith('application/json');
      await expectError(response, 400, code);
    }
    expect(calls()).toBe(0);
  });

  for (const era of ['legacy', 'auto'] as const) {
    test(`the SDK client (${era}) sends the negotiated version on every request after initialize`, async () => {
      const { app, calls } = countingApp();
      const sent: Array<{ method: string; version: string | null }> = [];
      const client = new Client(
        { name: 'header-check', version: '1.0.0' },
        { versionNegotiation: { mode: era } },
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL(PUBLIC_URL), {
          fetch: (url, init) => {
            const headers = new Headers(init?.headers);
            headers.set('Host', '127.0.0.1:3000');
            const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
            sent.push({
              method: body.method ?? init?.method ?? 'GET',
              version: headers.get('MCP-Protocol-Version'),
            });
            return app.fetch(new Request(String(url), { ...init, headers }));
          },
        }),
      );
      track(client);
      await client.listTools();
      await client.callTool({ name: 'counted', arguments: {} });

      const negotiated = client.getNegotiatedProtocolVersion() ?? null;
      expect(negotiated).toBeString();
      const afterInitialize = sent.filter(({ method }) => method !== 'initialize');
      expect(afterInitialize.length).toBeGreaterThanOrEqual(2);
      expect(afterInitialize).toEqual(
        afterInitialize.map(({ method }) => ({ method, version: negotiated })),
      );
      expect(calls()).toBe(1);
    });
  }
});
