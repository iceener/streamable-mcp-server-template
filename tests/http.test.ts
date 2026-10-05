import { afterEach, describe, expect, test } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/server';
import { type Deps, serverInfo } from '../src/server';
import { probe } from './fixture';
import { cleanup, message, PUBLIC_URL, post, testApp, testConfig, testDeps } from './helpers';

afterEach(cleanup);

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has('Host')) headers.set('Host', '127.0.0.1:3000');
  return new Request(new URL(path, PUBLIC_URL).href, { ...init, headers });
}

describe('Host and Origin guards', () => {
  test('every route rejects a Host that is not allowed', async () => {
    const app = testApp();
    for (const path of ['/mcp', '/health', '/icon.svg', '/missing']) {
      const response = await app.fetch(request(path, { headers: { Host: 'evil.example' } }));
      expect(response.status).toBe(403);
    }
  });

  test('rejects untrusted and malformed origins', async () => {
    const app = testApp();
    for (const origin of ['https://evil.example', 'null', 'not a url']) {
      const response = await post(app, message('tools/list'), { Origin: origin });
      expect(response.status).toBe(403);
    }
  });

  test('an allowed origin can read the response and its auth challenge header', async () => {
    const app = testApp();
    const response = await post(app, message('tools/list'), { Origin: 'http://localhost:6274' });

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:6274');
    expect(response.headers.get('Access-Control-Expose-Headers')).toBe('WWW-Authenticate');
    expect(response.headers.get('Vary')).toContain('Origin');
  });
});

describe('CORS preflight', () => {
  const preflight = (method: string, headers: string) =>
    request('/mcp', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:6274',
        'Access-Control-Request-Method': method,
        'Access-Control-Request-Headers': headers,
      },
    });

  test('allows POST with the MCP headers', async () => {
    const app = testApp();
    const response = await app.fetch(
      preflight('POST', 'content-type, authorization, mcp-protocol-version, mcp-method, mcp-name'),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('mcp-method');
  });

  test('refuses other methods, and allows any header the client asks for', async () => {
    const app = testApp();
    expect((await app.fetch(preflight('DELETE', 'content-type'))).status).toBe(405);

    const custom = await app.fetch(preflight('POST', 'content-type, x-request-id'));
    expect(custom.status).toBe(204);
    expect(custom.headers.get('Access-Control-Allow-Headers')).toBe('content-type, x-request-id');
  });
});

describe('request size', () => {
  const small = () => testApp(testConfig({ MCP_MAX_REQUEST_BYTES: '1024' }));

  test('a declared Content-Length over the limit is refused unread', async () => {
    const response = await post(small(), message('tools/list'), { 'Content-Length': '4096' });
    expect(response.status).toBe(413);
  });

  test('a streamed body is bounded without trusting Content-Length', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(new Uint8Array(600)),
    });
    const response = await small().fetch(
      request('/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body,
      }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: -32000 } });
  });
});

describe('routes', () => {
  test('health reports name and version only', async () => {
    const response = await testApp().fetch(request('/health'));
    expect(await response.json()).toEqual({
      status: 'ok',
      name: serverInfo.name,
      version: serverInfo.version,
    });
  });

  test('the icon is served as a sandboxed SVG', async () => {
    const response = await testApp().fetch(request('/icon.svg'));
    expect(response.headers.get('Content-Type')).toBe('image/svg+xml; charset=utf-8');
    expect(response.headers.get('Content-Security-Policy')).toContain('sandbox');
  });

  test('unknown paths answer JSON 404', async () => {
    const response = await testApp().fetch(request('/missing'));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });

  test('the MCP endpoint follows the public URL path', async () => {
    const app = testApp(testConfig({ MCP_PUBLIC_URL: 'http://127.0.0.1:3000/v1/mcp' }));
    const response = await app.fetch(
      request('/v1/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'tools/list',
        },
        body: JSON.stringify(message('tools/list')),
      }),
    );
    expect(response.status).toBe(200);
  });
});

describe('startup', () => {
  test('a registration mistake stops startup instead of failing every request', () => {
    const duplicate = (deps: Deps) => () => {
      const server = new McpServer({ name: 'broken', version: '1.0.0' });
      probe.register(server, deps);
      probe.register(server, deps);
      return server;
    };
    expect(() => testApp(testConfig(), { server: duplicate })).toThrow('already registered');
  });

  test('production without authentication says so in the log', () => {
    const config = testConfig({
      NODE_ENV: 'production',
      MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
      AUTH_MODE: 'none',
    });
    const deps = testDeps({ config });
    testApp(config, { deps });

    expect(deps.logs).toContainEqual(
      expect.objectContaining({
        level: 'warning',
        message: expect.stringContaining('Authentication is off'),
      }),
    );
  });
});

describe('routes from src/server.ts', () => {
  test('sit behind the same Host and Origin checks as MCP', async () => {
    const app = testApp(testConfig(), {
      routes: (hono) => {
        hono.post('/webhooks/test', (c) => c.json({ received: true }));
      },
    });

    const accepted = await app.fetch(request('/webhooks/test', { method: 'POST' }));
    expect(await accepted.json()).toEqual({ received: true });

    const foreign = await app.fetch(
      request('/webhooks/test', { method: 'POST', headers: { Host: 'evil.example' } }),
    );
    expect(foreign.status).toBe(403);
  });

  test("run after the MCP endpoint, so they can't intercept it", async () => {
    const seen: string[] = [];
    const app = testApp(testConfig(), {
      routes: (hono) => {
        hono.use(async (c, next) => {
          seen.push(c.req.path);
          await next();
        });
        hono.post('/mcp', (c) => c.text('shadowed'));
      },
    });

    const response = await post(app, message('tools/list'));
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty('result.tools');
    expect(seen).toEqual([]);
  });
});
