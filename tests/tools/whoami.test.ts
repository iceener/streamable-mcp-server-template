import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, connect, textOf } from '../helpers';

afterEach(cleanup);

describe('whoami', () => {
  test('reports an anonymous caller when authentication is off', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'whoami', arguments: {} });

    expect(result.structuredContent).toEqual({ authenticated: false, scopes: [] });
  });

  test('reports the verified caller without the token', async () => {
    const client = await connect({
      authInfo: {
        token: 'secret-token',
        clientId: 'client-1',
        scopes: ['mcp', 'actions:write'],
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        extra: { subject: 'user-1' },
      },
    });
    const result = await client.callTool({ name: 'whoami', arguments: {} });

    expect(result.structuredContent).toEqual({
      authenticated: true,
      clientId: 'client-1',
      subject: 'user-1',
      scopes: ['mcp', 'actions:write'],
    });
    expect(textOf(result)).not.toContain('secret-token');
  });
});
