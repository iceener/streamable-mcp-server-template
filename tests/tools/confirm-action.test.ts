import { afterEach, describe, expect, test } from 'bun:test';
import type { Client } from '@modelcontextprotocol/client';
import type { ElicitResult } from '@modelcontextprotocol/server';
import { cleanup, connect, textOf } from '../helpers';

afterEach(cleanup);

async function connectAnswering(answer: ElicitResult): Promise<Client> {
  const client = await connect({ capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler('elicitation/create', async () => answer);
  return client;
}

describe('confirm-action', () => {
  test('runs once the user approves', async () => {
    const client = await connectAnswering({ action: 'accept', content: { approve: true } });
    const result = await client.callTool({
      name: 'confirm-action',
      arguments: { action: 'Archive the report' },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe('Approved: Archive the report');
  });

  test('stops when the user declines', async () => {
    const client = await connectAnswering({ action: 'decline' });
    const result = await client.callTool({
      name: 'confirm-action',
      arguments: { action: 'Archive the report' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('did not approve');
  });

  test('2025-era clients cannot be asked over stateless HTTP, so nothing runs', async () => {
    const client = await connect({ era: 'legacy', capabilities: { elicitation: { form: {} } } });
    const result = await client.callTool({
      name: 'confirm-action',
      arguments: { action: 'Archive the report' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('cannot receive server-to-client requests');
  });

  test('requires the actions:write scope before the handler runs', async () => {
    const client = await connect({
      authInfo: { token: '', clientId: 'reader', scopes: ['mcp'], expiresAt: 4_102_444_800 },
    });

    await expect(
      client.callTool({ name: 'confirm-action', arguments: { action: 'Archive the report' } }),
    ).rejects.toThrow(/Insufficient scope: required "actions:write"/);
  });
});
