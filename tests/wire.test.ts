import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { parseConfig } from '../src/config/env.js';
import { buildHttpApp, type HttpRuntime } from '../src/http/app.js';

const endpoint = 'http://localhost:3000/mcp';
const version = '2026-07-28';
const infoKey = 'io.modelcontextprotocol/serverInfo';
let runtime: HttpRuntime;

beforeEach(() => {
  runtime = buildHttpApp(
    parseConfig({
      NODE_ENV: 'test',
      MCP_PUBLIC_URL: endpoint,
      MCP_MAX_REQUEST_BYTES: '1024',
    }),
    { runtimeName: 'wire-test' },
  );
});
afterEach(() => runtime.close());

function message(method = 'server/discover', params: Record<string, unknown> = {}) {
  return {
    jsonrpc: '2.0',
    id: 42,
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': version,
        'io.modelcontextprotocol/clientCapabilities': {},
        // clientInfo is a SHOULD in stable, deliberately omitted here.
      },
    },
  };
}

function post(
  body = message(),
  overrides: Record<string, string | null | undefined> = {},
) {
  const headers = new Headers({
    Host: 'localhost:3000',
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': version,
    'Mcp-Method': body.method,
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) headers.delete(key);
    else if (value !== undefined) headers.set(key, value);
  }
  return runtime.fetch(
    new Request(endpoint, { method: 'POST', headers, body: JSON.stringify(body) }),
  );
}

async function expectError(response: Response, status: number, code: number) {
  expect(response.status).toBe(status);
  expect(response.headers.has('Mcp-Session-Id')).toBe(false);
  expect(await response.json()).toMatchObject({ jsonrpc: '2.0', error: { code } });
}

describe('published SDK 2.0.0 raw wire contract (not unreleased main)', () => {
  test('omitted clientInfo works; identity is result._meta, not result.serverInfo', async () => {
    for (const method of [
      'server/discover',
      'tools/list',
      'prompts/list',
      'resources/list',
    ]) {
      const response = await post(message(method));
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('application/json');
      expect(response.headers.has('Mcp-Session-Id')).toBe(false);
      const body = await response.json();
      expect(body).toMatchObject({
        jsonrpc: '2.0',
        id: 42,
        result: {
          _meta: { [infoKey]: { name: 'mcp-server-template', version: '1.0.0' } },
        },
      });
      expect(body.result).not.toHaveProperty('serverInfo');
    }
  });

  test('records stable acceptance of missing protocol header; enforcement is unreleased', async () => {
    const response = await post(message(), { 'MCP-Protocol-Version': null });
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty(`result._meta`);
  });

  test('rejects missing/mismatched method, version, and conditional name headers', async () => {
    for (const headers of [
      { 'Mcp-Method': null },
      { 'Mcp-Method': 'tools/list' },
      { 'MCP-Protocol-Version': '2025-11-25' },
    ]) {
      await expectError(await post(message(), headers), 400, -32020);
    }
    const call = message('tools/call', {
      name: 'echo',
      arguments: { message: 'wire' },
    });
    for (const name of [null, 'health']) {
      await expectError(await post(call, { 'Mcp-Name': name }), 400, -32020);
    }
    expect((await post(call, { 'Mcp-Name': 'echo' })).status).toBe(200);
  });

  test('rejects malformed metadata, unsupported revisions, and invalid JSON', async () => {
    const missingCapabilities = message();
    Reflect.deleteProperty(
      missingCapabilities.params._meta,
      'io.modelcontextprotocol/clientCapabilities',
    );
    await expectError(await post(missingCapabilities), 400, -32602);
    const unsupported = message();
    unsupported.params._meta['io.modelcontextprotocol/protocolVersion'] = '2099-01-01';
    await expectError(
      await post(unsupported, { 'MCP-Protocol-Version': '2099-01-01' }),
      400,
      -32022,
    );
    await expectError(
      await runtime.fetch(
        new Request(endpoint, {
          method: 'POST',
          headers: {
            Host: 'localhost',
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: '{',
        }),
      ),
      400,
      -32700,
    );
  });

  test('rejects non-POST methods and wrong media types', async () => {
    for (const method of ['GET', 'DELETE', 'PUT', 'PATCH']) {
      const response = await runtime.fetch(
        new Request(endpoint, {
          method,
          headers: { Host: 'localhost', 'MCP-Protocol-Version': version },
        }),
      );
      expect(response.status).toBe(405);
      expect(response.headers.has('Mcp-Session-Id')).toBe(false);
    }
    for (const contentType of [null, 'text/plain', 'application/jsonp']) {
      await expectError(
        await post(message(), { 'Content-Type': contentType }),
        415,
        -32000,
      );
    }
    expect(
      (await post(message(), { 'Content-Type': 'application/json; charset=utf-8' }))
        .status,
    ).toBe(200);
  });

  test('legacy initialization keeps root serverInfo and requires both Accept media types', async () => {
    const initialize = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'raw-legacy', version: '1.0.0' },
      },
    });
    for (const accept of ['application/json', 'text/event-stream']) {
      await expectError(
        await runtime.fetch(
          new Request(endpoint, {
            method: 'POST',
            headers: {
              Host: 'localhost',
              'Content-Type': 'application/json',
              Accept: accept,
            },
            body: initialize,
          }),
        ),
        406,
        -32000,
      );
    }
    const response = await runtime.fetch(
      new Request(endpoint, {
        method: 'POST',
        headers: {
          Host: 'localhost',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: initialize,
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.has('Mcp-Session-Id')).toBe(false);
    // The stateless legacy fallback responds via SSE; decode the terminal event.
    const event = (await response.text())
      .split('\n')
      .find((line) => line.startsWith('data: '));
    expect(event).toBeDefined();
    const body = JSON.parse(event?.slice(6) ?? 'null');
    expect(body.result.serverInfo).toMatchObject({
      name: 'mcp-server-template',
      version: '1.0.0',
    });
    expect(body.result.capabilities.resources.subscribe).toBe(false);
  });

  test('validates untrusted and malformed origins and browser preflight headers', async () => {
    for (const origin of ['null', 'not a URL', 'https://evil.example']) {
      expect((await post(message(), { Origin: origin })).status).toBe(403);
    }
    expect((await post(message(), { Host: null })).status).toBe(403);
    for (const [method, headers, status] of [
      ['DELETE', 'content-type', 405],
      ['POST', 'x-untrusted', 400],
      ['POST', 'content-type, mcp-method, mcp-name, mcp-protocol-version', 204],
    ] as const) {
      const response = await runtime.fetch(
        new Request(endpoint, {
          method: 'OPTIONS',
          headers: {
            Host: 'localhost',
            Origin: 'http://localhost:9876',
            'Access-Control-Request-Method': method,
            'Access-Control-Request-Headers': headers,
          },
        }),
      );
      expect(response.status).toBe(status);
    }
    const allowed = await post(message(), { Origin: 'http://localhost:9876' });
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe(
      'http://localhost:9876',
    );
    expect(allowed.headers.get('Vary')).toContain('Origin');
  });

  test('bounds streamed bodies without trusting Content-Length and cancels the producer', async () => {
    for (const contentLength of [undefined, '1']) {
      let canceled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(600));
        },
        cancel() {
          canceled = true;
        },
      });
      const headers = new Headers({
        Host: 'localhost',
        'Content-Type': 'application/json',
      });
      if (contentLength) headers.set('Content-Length', contentLength);
      const response = await runtime.fetch(
        new Request(endpoint, { method: 'POST', headers, body: stream }),
      );
      await expectError(response, 413, -32600);
      expect(canceled).toBe(true);
    }
    const declared = await runtime.fetch(
      new Request(endpoint, {
        method: 'POST',
        headers: {
          Host: 'localhost',
          'Content-Type': 'application/json',
          'Content-Length': '1025',
        },
        body: '{}',
      }),
    );
    await expectError(declared, 413, -32600);
  });
});
