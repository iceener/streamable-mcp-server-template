import { afterEach, describe, expect, test } from 'bun:test';
import { FIXTURE } from './fixture';
import { cleanup, message, PUBLIC_URL, post, testApp, testConfig } from './helpers';

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
