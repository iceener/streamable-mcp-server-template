import { afterEach, describe, expect, test } from 'bun:test';
import {
  Client,
  type FetchLike,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { AuthInfo, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { type AppConfig, parseConfig } from '../src/config/env.js';
import { buildHttpApp, type HttpRuntime } from '../src/http/app.js';
import { createJwtVerifier } from '../src/shared/auth/jwt-verifier.js';

interface Exchange {
  method: string;
  requestHeaders: Headers;
  requestBody?: string;
  status: number;
  responseHeaders: Headers;
}

interface TestConnection {
  client: Client;
  exchanges: Exchange[];
}

const activeRuntimes = new Set<HttpRuntime>();
const activeClients = new Set<Client>();

afterEach(async () => {
  await Promise.all([...activeClients].map((client) => client.close()));
  await Promise.all([...activeRuntimes].map((runtime) => runtime.close()));
  activeClients.clear();
  activeRuntimes.clear();
});

function testConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return parseConfig({
    NODE_ENV: 'test',
    MCP_PUBLIC_URL: 'http://localhost:3000/mcp',
    MCP_ALLOWED_HOSTS: 'localhost',
    MCP_ALLOWED_ORIGIN_HOSTNAMES: 'localhost',
    ...overrides,
  });
}

function createRuntime(
  config = testConfig(),
  verifier?: OAuthTokenVerifier,
): HttpRuntime {
  const runtime = buildHttpApp(config, {
    runtimeName: 'test',
    ...(verifier ? { verifier } : {}),
  });
  activeRuntimes.add(runtime);
  return runtime;
}

function runtimeFetch(
  runtime: HttpRuntime,
  exchanges: Exchange[],
  token?: string,
): FetchLike {
  return async (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set('Host', 'localhost:3000');
    if (token) headers.set('Authorization', `Bearer ${token}`);

    const response = await runtime.fetch(new Request(url, { ...init, headers }));
    exchanges.push({
      method: init?.method ?? 'GET',
      requestHeaders: new Headers(headers),
      ...(typeof init?.body === 'string' ? { requestBody: init.body } : {}),
      status: response.status,
      responseHeaders: new Headers(response.headers),
    });
    return response;
  };
}

async function connect(
  runtime: HttpRuntime,
  mode: 'modern' | 'legacy',
  token?: string,
): Promise<TestConnection> {
  const exchanges: Exchange[] = [];
  const client = new Client(
    { name: `test-${mode}`, version: '1.0.0' },
    mode === 'modern'
      ? { versionNegotiation: { mode: { pin: '2026-07-28' } } }
      : undefined,
  );
  const transport = new StreamableHTTPClientTransport(
    new URL('http://localhost:3000/mcp'),
    {
      fetch: runtimeFetch(runtime, exchanges, token),
      ...(token ? { authProvider: { token: async () => token } } : {}),
    },
  );

  await client.connect(transport);
  activeClients.add(client);
  return { client, exchanges };
}

function textFromContent(content: unknown): string | undefined {
  if (!content || typeof content !== 'object' || !('text' in content)) return undefined;
  return typeof content.text === 'string' ? content.text : undefined;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Timed out waiting for event')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('MCP 2026-07-28', () => {
  test('negotiates the modern era and serves all advertised primitives', async () => {
    const runtime = createRuntime();
    const { client, exchanges } = await connect(runtime, 'modern');

    expect(client.getProtocolEra()).toBe('modern');
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect(client.getServerCapabilities()).toEqual({
      completions: {},
      prompts: { listChanged: true },
      resources: { listChanged: true, subscribe: true },
      tools: { listChanged: true },
    });

    const tools = await client.listTools();
    expect(tools.ttlMs).toBe(60_000);
    expect(tools.cacheScope).toBe('private');
    expect(tools.tools.map((tool) => tool.name)).toEqual(['echo', 'health']);
    expect(tools.tools[0]?.icons?.[0]?.mimeType).toBe('image/svg+xml');

    const called = await client.callTool({
      name: 'echo',
      arguments: { message: 'hello', uppercase: true },
    });
    expect(called.structuredContent).toEqual({
      echoed: 'HELLO',
      length: 5,
      steps: 1,
    });

    const resources = await client.listResources();
    expect(
      resources.resources.some(
        (resource) => resource.uri === 'docs://mcp-template/guide',
      ),
    ).toBe(true);
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates[0]?.uriTemplate).toBe(
      'example://items/{collection}/{id}',
    );
    const resource = await client.readResource({
      uri: 'example://items/books/1',
    });
    expect(resource.cacheScope).toBe('public');
    expect(textFromContent(resource.contents[0])).toContain('"ok":true');

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name)).toEqual([
      'greeting',
      'analysis',
    ]);
    const prompt = await client.getPrompt({
      name: 'greeting',
      arguments: { name: 'Ada', language: 'fr' },
    });
    expect(textFromContent(prompt.messages[0]?.content)).toBe('Bonjour, Ada!');
    const completion = await client.complete({
      ref: { type: 'ref/prompt', name: 'greeting' },
      argument: { name: 'language', value: 'e' },
    });
    expect(completion.completion.values).toEqual(['en', 'es']);

    const modernRequests = exchanges.filter(
      (exchange) =>
        exchange.requestHeaders.get('MCP-Protocol-Version') === '2026-07-28',
    );
    expect(modernRequests.length).toBeGreaterThan(1);
    for (const exchange of modernRequests) {
      expect(exchange.requestHeaders.get('Mcp-Method')).toBeTruthy();
      expect(exchange.requestHeaders.has('Mcp-Session-Id')).toBe(false);
      expect(exchange.responseHeaders.has('Mcp-Session-Id')).toBe(false);
    }
  });

  test('reports invalid tool input and resource/prompt lookup failures', async () => {
    const { client } = await connect(createRuntime(), 'modern');
    const invalid = await client.callTool({ name: 'echo', arguments: { message: '' } });
    expect(invalid.isError).toBe(true);
    await expect(
      client.readResource({ uri: 'example://items/unknown/1' }),
    ).rejects.toThrow();
    await expect(client.getPrompt({ name: 'unknown' })).rejects.toThrow();
  });

  test('streams progress and cancels work through the request signal', async () => {
    const runtime = createRuntime();
    const { client, exchanges } = await connect(runtime, 'modern');
    await client.listTools();

    const progress: number[] = [];
    const result = await client.callTool(
      {
        name: 'echo',
        arguments: { message: 'progress', delayMs: 45, steps: 3 },
      },
      {
        onprogress: (notification) => {
          progress.push(notification.progress);
        },
      },
    );
    expect(result.isError).not.toBe(true);
    expect(progress).toEqual([1, 2, 3]);
    expect(
      exchanges.some((exchange) =>
        exchange.responseHeaders.get('Content-Type')?.startsWith('text/event-stream'),
      ),
    ).toBe(true);

    const controller = new AbortController();
    const pending = client.callTool(
      {
        name: 'echo',
        arguments: { message: 'cancel', delayMs: 1_000, steps: 10 },
      },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toThrow();
  });

  test('acknowledges and delivers modern change subscriptions', async () => {
    const runtime = createRuntime();
    const { client } = await connect(runtime, 'modern');

    let received: (() => void) | undefined;
    const changed = new Promise<void>((resolve) => {
      received = resolve;
    });
    client.setNotificationHandler('notifications/tools/list_changed', async () => {
      received?.();
    });

    const subscription = await client.listen({ toolsListChanged: true });
    expect(subscription.honoredFilter).toEqual({ toolsListChanged: true });
    runtime.notify.toolsChanged();
    await withTimeout(changed);

    await subscription.close();
    expect(await subscription.closed).toBe('local');
  });

  test('returns modern transport and header errors from the SDK', async () => {
    const runtime = createRuntime();

    const getResponse = await runtime.fetch(
      new Request('http://localhost:3000/mcp', {
        method: 'GET',
        headers: { Host: 'localhost:3000' },
      }),
    );
    expect(getResponse.status).toBe(405);
    expect(getResponse.headers.has('Mcp-Session-Id')).toBe(false);

    const discoverBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': {
            name: 'raw-test',
            version: '1.0.0',
          },
        },
      },
    });
    const mismatch = await runtime.fetch(
      new Request('http://localhost:3000/mcp', {
        method: 'POST',
        headers: {
          Host: 'localhost:3000',
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'tools/list',
        },
        body: discoverBody,
      }),
    );
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({
      error: { code: -32020 },
    });

    const unsupportedMediaType = await runtime.fetch(
      new Request('http://localhost:3000/mcp', {
        method: 'POST',
        headers: {
          Host: 'localhost:3000',
          'Content-Type': 'text/plain',
        },
        body: discoverBody,
      }),
    );
    expect(unsupportedMediaType.status).toBe(415);
  });
});

describe('legacy interoperability', () => {
  test('can reject initialization-era clients on a modern-only endpoint', async () => {
    const runtime = createRuntime(testConfig({ MCP_LEGACY_MODE: 'reject' }));
    const response = await runtime.fetch(
      new Request('http://localhost:3000/mcp', {
        method: 'POST',
        headers: {
          Host: 'localhost:3000',
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'legacy-client', version: '1.0.0' },
          },
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: -32022 } });
  });

  test('uses the SDK stateless fallback without advertising session features', async () => {
    const runtime = createRuntime();
    const { client, exchanges } = await connect(runtime, 'legacy');

    expect(client.getProtocolEra()).toBe('legacy');
    expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(false);
    expect(client.getServerCapabilities()?.resources?.subscribe).toBe(false);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(['echo', 'health']);
    const result = await client.callTool({
      name: 'echo',
      arguments: { message: 'legacy' },
    });
    expect(result.structuredContent).toEqual({
      echoed: 'legacy',
      length: 6,
      steps: 1,
    });
    expect(
      exchanges.some(
        (exchange) => exchange.method === 'GET' && exchange.status === 405,
      ),
    ).toBe(true);
    expect(
      exchanges.every((exchange) => !exchange.responseHeaders.has('Mcp-Session-Id')),
    ).toBe(true);
  });
});

describe('HTTP security and OAuth Resource Server mode', () => {
  test('enforces Host, Origin, CORS, and request-size boundaries', async () => {
    const runtime = createRuntime(testConfig({ MCP_MAX_REQUEST_BYTES: '1024' }));
    const untrustedOrigin = await runtime.fetch(
      new Request('http://localhost:3000/mcp', {
        method: 'POST',
        headers: {
          Host: 'localhost:3000',
          Origin: 'https://evil.example',
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
    );
    expect(untrustedOrigin.status).toBe(403);
    expect(untrustedOrigin.headers.has('Access-Control-Allow-Origin')).toBe(false);

    const untrustedHost = await runtime.fetch(
      new Request('http://localhost:3000/health', {
        headers: { Host: 'evil.example' },
      }),
    );
    expect(untrustedHost.status).toBe(403);

    const preflight = await runtime.fetch(
      new Request('http://localhost:3000/mcp', {
        method: 'OPTIONS',
        headers: {
          Host: 'localhost:3000',
          Origin: 'http://localhost:8080',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers':
            'authorization, content-type, mcp-param-tenant',
        },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(
      'http://localhost:8080',
    );

    const oversized = await runtime.fetch(
      new Request('http://localhost:3000/mcp', {
        method: 'POST',
        headers: {
          Host: 'localhost:3000',
          'Content-Type': 'application/json',
        },
        body: 'x'.repeat(1_025),
      }),
    );
    expect(oversized.status).toBe(413);
  });

  test('fails closed on invalid auth and production transport configuration', () => {
    expect(() => testConfig({ AUTH_ENABLED: 'treu' })).toThrow(
      'AUTH_ENABLED must be true or false',
    );

    expect(() =>
      parseConfig({
        NODE_ENV: 'production',
        MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
        AUTH_ENABLED: 'true',
        OAUTH_ISSUER_URL: 'https://auth.example.com',
        OAUTH_AUTHORIZATION_URL: 'https://auth.example.com/authorize',
        OAUTH_TOKEN_URL: 'https://auth.example.com/token',
        OAUTH_JWKS_URL: 'http://keys.example.com/jwks',
        OAUTH_AUDIENCE: 'https://mcp.example.com/mcp',
      }),
    ).toThrow('OAUTH_JWKS_URL must use HTTPS in production');
  });

  test('validates JWT signature, issuer, audience, expiry, and client ID', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    const key = { ...jwk, alg: 'RS256', kid: 'test-key', use: 'sig' };
    const jwksServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({ keys: [key] }),
    });

    try {
      const issuer = 'https://issuer.example';
      const audience = 'https://mcp.example.com/mcp';
      const config = testConfig({
        MCP_PUBLIC_URL: audience,
        AUTH_ENABLED: 'true',
        OAUTH_ISSUER_URL: issuer,
        OAUTH_AUTHORIZATION_URL: `${issuer}/authorize`,
        OAUTH_TOKEN_URL: `${issuer}/token`,
        OAUTH_JWKS_URL: `http://127.0.0.1:${jwksServer.port}/jwks`,
        OAUTH_AUDIENCE: audience,
        OAUTH_REQUIRED_SCOPES: 'mcp',
        OAUTH_JWT_ALGORITHMS: 'RS256',
      });
      const verifier = createJwtVerifier(config);
      const valid = await new SignJWT({
        client_id: 'jwt-client',
        scope: 'mcp',
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);

      await expect(verifier.verifyAccessToken(valid)).resolves.toMatchObject({
        clientId: 'jwt-client',
        scopes: ['mcp'],
        resource: new URL(audience),
      });

      const claims = {
        client_id: 'jwt-client',
        scope: 'mcp',
        iss: issuer,
        aud: audience,
        exp: Math.floor(Date.now() / 1_000) + 300,
      };
      for (const overrides of [
        ...[
          'https://other.example/mcp',
          'https://MCP.example.com/mcp',
          'https://mcp.example.com:443/mcp',
          'https://mcp.example.com/m%63p',
          `${audience}/`,
          `${audience}#fragment`,
          `${audience}?x=1`,
        ].map((aud) => ({ aud })),
        { aud: ['https://other.example/mcp'] },
        { iss: `${issuer}/` },
        { exp: 1 },
        { exp: undefined },
        { client_id: undefined },
        { client_id: '' },
      ]) {
        const invalid = await new SignJWT({ ...claims, ...overrides })
          .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
          .sign(privateKey);
        await expect(verifier.verifyAccessToken(invalid)).rejects.toMatchObject({
          code: 'invalid_token',
        });
      }
      const multiAudience = await new SignJWT({
        ...claims,
        aud: ['https://other.example/mcp', audience],
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .sign(privateKey);
      await expect(verifier.verifyAccessToken(multiAudience)).resolves.toMatchObject({
        clientId: 'jwt-client',
      });
      const otherKey = await generateKeyPair('RS256');
      const forged = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .sign(otherKey.privateKey);
      await expect(verifier.verifyAccessToken(forged)).rejects.toMatchObject({
        code: 'invalid_token',
      });
      const esKey = await generateKeyPair('ES256');
      const wrongAlgorithm = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
        .sign(esKey.privateKey);
      await expect(verifier.verifyAccessToken(wrongAlgorithm)).rejects.toMatchObject({
        code: 'invalid_token',
      });
    } finally {
      await jwksServer.stop(true);
    }
  });

  test('public OAuth discovery allows browser origins without loosening application guards', async () => {
    const runtime = createRuntime(
      testConfig({
        AUTH_ENABLED: 'true',
        OAUTH_ISSUER_URL: 'http://localhost:4000',
        OAUTH_AUTHORIZATION_URL: 'http://localhost:4000/authorize',
        OAUTH_TOKEN_URL: 'http://localhost:4000/token',
      }),
      {
        async verifyAccessToken() {
          throw new Error('Discovery must not verify tokens');
        },
      },
    );
    for (const path of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-authorization-server',
    ]) {
      for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST']) {
        const response = await runtime.fetch(
          new Request(`http://localhost:3000${path}`, {
            method,
            headers: {
              Host: 'localhost:3000',
              Origin: 'https://browser-client.example',
            },
          }),
        );
        expect(response.status).toBe(
          method === 'OPTIONS' ? 204 : method === 'POST' ? 405 : 200,
        );
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
        if (method === 'HEAD' || method === 'OPTIONS')
          expect(await response.text()).toBe('');
      }
      const badHost = await runtime.fetch(
        new Request(`http://localhost:3000${path}`, {
          headers: { Host: 'evil.example', Origin: 'https://browser-client.example' },
        }),
      );
      expect(badHost.status).toBe(403);
      expect(badHost.headers.has('Access-Control-Allow-Origin')).toBe(false);
    }
    for (const path of ['/mcp', '/health', '/.well-known/not-oauth-metadata']) {
      const response = await runtime.fetch(
        new Request(`http://localhost:3000${path}`, {
          headers: { Host: 'localhost:3000', Origin: 'https://browser-client.example' },
        }),
      );
      expect(response.status).toBe(403);
      expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
    }
  });

  test('serves RFC 9728 metadata and isolates AuthInfo between principals', async () => {
    const config = testConfig({
      AUTH_ENABLED: 'true',
      OAUTH_ISSUER_URL: 'http://localhost:4000',
      OAUTH_AUTHORIZATION_URL: 'http://localhost:4000/authorize',
      OAUTH_TOKEN_URL: 'http://localhost:4000/token',
      OAUTH_AUDIENCE: 'http://localhost:3000/mcp',
      OAUTH_REQUIRED_SCOPES: 'mcp',
    });
    const verifier: OAuthTokenVerifier = {
      async verifyAccessToken(token): Promise<AuthInfo> {
        return {
          token,
          clientId: token,
          scopes: token === 'limited-client' ? [] : ['mcp'],
          expiresAt: Math.floor(Date.now() / 1_000) + 300,
          resource: new URL('http://localhost:3000/mcp'),
        };
      },
    };
    const runtime = createRuntime(config, verifier);

    const metadata = await runtime.fetch(
      new Request('http://localhost:3000/.well-known/oauth-protected-resource/mcp', {
        headers: { Host: 'localhost:3000' },
      }),
    );
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      resource: 'http://localhost:3000/mcp',
      authorization_servers: ['http://localhost:4000'],
      scopes_supported: ['mcp'],
    });

    const challenge = await runtime.fetch(
      new Request('http://localhost:3000/mcp', {
        method: 'GET',
        headers: { Host: 'localhost:3000' },
      }),
    );
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('WWW-Authenticate')).toContain('resource_metadata=');

    const insufficientScope = await runtime.fetch(
      new Request('http://localhost:3000/mcp', {
        method: 'GET',
        headers: {
          Host: 'localhost:3000',
          Authorization: 'Bearer limited-client',
        },
      }),
    );
    expect(insufficientScope.status).toBe(403);
    expect(insufficientScope.headers.get('WWW-Authenticate')).toContain(
      'insufficient_scope',
    );

    const [alice, bob] = await Promise.all([
      connect(runtime, 'modern', 'alice-client'),
      connect(runtime, 'modern', 'bob-client'),
    ]);
    const [aliceHealth, bobHealth] = await Promise.all([
      alice.client.callTool({ name: 'health', arguments: {} }),
      bob.client.callTool({ name: 'health', arguments: {} }),
    ]);
    expect(aliceHealth.structuredContent).toMatchObject({
      authenticated: true,
      clientId: 'alice-client',
    });
    expect(bobHealth.structuredContent).toMatchObject({
      authenticated: true,
      clientId: 'bob-client',
    });
  });
});
