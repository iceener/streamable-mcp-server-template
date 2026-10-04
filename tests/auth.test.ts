import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose';
import type { App } from '../src/platform/app';
import { serverInfo } from '../src/server';
import {
  cleanup,
  type LogEntry,
  memoryLogger,
  message,
  PUBLIC_URL,
  post,
  testApp,
  testConfig,
  testDeps,
  textOf,
  track,
} from './helpers';

/** A stand-in authorization server: a signing key, and its JWKS on a local port. */
let issuer: string;
let sign: (claims: JWTPayload, alg?: 'RS256' | 'HS256') => Promise<string>;
let jwks: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  jwks = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ keys: [jwk] }) });
  issuer = `http://127.0.0.1:${jwks.port}`;

  sign = async (claims, alg = 'RS256') => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = new SignJWT({
      iss: issuer,
      aud: PUBLIC_URL,
      client_id: 'client-1',
      sub: 'user-1',
      scope: 'mcp',
      iat: now,
      exp: now + 300,
      ...claims,
    }).setProtectedHeader({ alg, kid: 'test-key' });
    return alg === 'HS256'
      ? jwt.sign(new TextEncoder().encode('a-shared-secret-of-sufficient-length!!'))
      : jwt.sign(privateKey);
  };
});

afterAll(() => jwks.stop(true));
afterEach(cleanup);

function oauthApp(env: Record<string, string> = {}, logs: LogEntry[] = []): App {
  const config = testConfig({
    AUTH_MODE: 'oauth',
    OAUTH_ISSUER_URL: issuer,
    OAUTH_AUTHORIZATION_URL: `${issuer}/authorize`,
    OAUTH_TOKEN_URL: `${issuer}/token`,
    OAUTH_JWKS_URL: `${issuer}/jwks.json`,
    OAUTH_SCOPES: 'mcp',
    ...env,
  });
  return testApp(config, { deps: testDeps({ config, logger: memoryLogger(logs) }) });
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function connectWith(app: App, token: string): Promise<Client> {
  const client = new Client(
    { name: 'test', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(PUBLIC_URL), {
      fetch: (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set('Host', '127.0.0.1:3000');
        headers.set('Authorization', `Bearer ${token}`);
        return app.fetch(new Request(String(url), { ...init, headers }));
      },
    }),
  );
  return track(client);
}

describe('discovery', () => {
  test('publishes RFC 9728 metadata at the path-aware location, readable from any origin', async () => {
    const response = await oauthApp().fetch(
      new Request('http://127.0.0.1:3000/.well-known/oauth-protected-resource/mcp', {
        headers: { Host: '127.0.0.1:3000', Origin: 'https://any-client.example' },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await response.json()).toEqual({
      resource: PUBLIC_URL,
      authorization_servers: [issuer],
      scopes_supported: ['mcp'],
      resource_name: serverInfo.title,
    });
  });

  test('mirrors the authorization server metadata, with PKCE S256', async () => {
    const response = await oauthApp().fetch(
      new Request('http://127.0.0.1:3000/.well-known/oauth-authorization-server', {
        headers: { Host: '127.0.0.1:3000' },
      }),
    );
    expect(await response.json()).toMatchObject({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
    });
  });

  test('a request without a token is challenged toward the metadata', async () => {
    const response = await post(oauthApp(), message('tools/list'));

    expect(response.status).toBe(401);
    const challenge = response.headers.get('WWW-Authenticate') ?? '';
    expect(challenge).toStartWith('Bearer ');
    expect(challenge).toContain(
      'resource_metadata="http://127.0.0.1:3000/.well-known/oauth-protected-resource/mcp"',
    );
  });
});

describe('tokens', () => {
  test('a valid token reaches the handlers, which see the caller but not the token', async () => {
    const token = await sign({});
    const client = await connectWith(oauthApp(), token);
    const result = await client.callTool({ name: 'caller', arguments: {} });

    expect(JSON.parse(textOf(result))).toMatchObject({
      token: '',
      clientId: 'client-1',
      scopes: ['mcp'],
      resource: PUBLIC_URL,
      extra: { subject: 'user-1' },
    });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  test('azp is accepted when client_id is absent', async () => {
    const response = await post(
      oauthApp(),
      message('tools/list'),
      bearer(await sign({ client_id: undefined, azp: 'client-2' })),
    );
    expect(response.status).toBe(200);
  });

  const rejected: Array<[string, () => Promise<string>]> = [
    ['issued for another server', () => sign({ aud: 'https://other.example/mcp' })],
    ['issued by another server', () => sign({ iss: 'https://evil.example' })],
    ['that has expired', () => sign({ exp: Math.floor(Date.now() / 1000) - 120 })],
    ['that is not yet valid', () => sign({ nbf: Math.floor(Date.now() / 1000) + 120 })],
    ['signed with a shared secret', () => sign({}, 'HS256')],
    ['without a client', () => sign({ client_id: undefined })],
    ['that is malformed', async () => 'not-a-jwt'],
  ];
  for (const [label, token] of rejected) {
    test(`a token ${label} is rejected with 401`, async () => {
      const response = await post(oauthApp(), message('tools/list'), bearer(await token()));
      expect(response.status).toBe(401);
      expect(response.headers.get('WWW-Authenticate')).toContain('error="invalid_token"');
    });
  }

  test('a token without the required scopes gets 403 insufficient_scope', async () => {
    const response = await post(
      oauthApp(),
      message('tools/list'),
      bearer(await sign({ scope: 'other' })),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('WWW-Authenticate')).toContain('error="insufficient_scope"');
  });

  test('a tool scope is challenged before the tool runs (step-up)', async () => {
    const call = message('tools/call', { name: 'scoped', arguments: {} });
    const headers = { 'Mcp-Name': 'scoped' };

    const reader = await post(oauthApp(), call, { ...headers, ...bearer(await sign({})) });
    expect(reader.status).toBe(403);
    expect(reader.headers.get('WWW-Authenticate')).toContain('scope="probe:write"');

    const writer = await post(oauthApp(), call, {
      ...headers,
      ...bearer(await sign({ scope: 'mcp probe:write' })),
    });
    expect(writer.status).toBe(200);
  });

  test('an unreachable key set is a server error, not an invalid token', async () => {
    const logs: LogEntry[] = [];
    const app = oauthApp({ OAUTH_JWKS_URL: 'http://127.0.0.1:9/jwks.json' }, logs);
    const response = await post(app, message('tools/list'), bearer(await sign({})));

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: 'server_error' });
    expect(logs.map(({ level, message }) => [level, message])).toContainEqual([
      'error',
      'Could not load the authorization server key set',
    ]);
  });
});
