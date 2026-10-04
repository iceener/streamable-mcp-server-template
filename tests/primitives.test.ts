import { afterEach, describe, expect, test } from 'bun:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  createMcpHandler,
  McpServer,
  ProtocolErrorCode,
  ResourceNotFoundError,
} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {
  type Definition,
  definePrompt,
  defineResource,
  defineTool,
  toolError,
} from '../src/platform/primitives';
import { cleanup, PUBLIC_URL, testDeps, textOf, track } from './helpers';

afterEach(cleanup);

const LEAKY = 'upstream https://api.internal.example/v1?key=SECRET failed';

/** Serve only the given definitions, so each policy case is isolated. */
async function serve(...definitions: Definition[]) {
  const deps = testDeps();
  const handler = track(
    createMcpHandler(() => {
      const server = new McpServer({ name: 'policy-test', version: '1.0.0' });
      for (const definition of definitions) definition.register(server, deps);
      return server;
    }),
  );
  const client = new Client(
    { name: 'test', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(PUBLIC_URL), {
      fetch: (url, init) => handler.fetch(new Request(String(url), init)),
    }),
  );
  return { client: track(client), deps };
}

describe('error policy', () => {
  test('a tool that throws: logged with a reference, never shown to the model', async () => {
    const tool = defineTool('leaky', { description: 'Fails' }, () => {
      throw new Error(LEAKY);
    });
    const { client, deps } = await serve(tool);

    const result = await client.callTool({ name: 'leaky', arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain('SECRET');
    const [entry] = deps.logs;
    expect(entry).toMatchObject({ level: 'error', message: 'Unexpected tool failure' });
    expect(entry?.fields.tool).toBe('leaky');
    expect(textOf(result)).toContain(String(entry?.fields.reference));
  });

  test('a tool error is shown as written and not logged', async () => {
    const tool = defineTool('picky', { description: 'Refuses' }, () =>
      toolError('Ask for a smaller range.'),
    );
    const { client, deps } = await serve(tool);

    const result = await client.callTool({ name: 'picky', arguments: {} });

    expect(result).toMatchObject({ isError: true });
    expect(textOf(result)).toBe('Ask for a smaller range.');
    expect(deps.logs).toEqual([]);
  });

  test('handlers receive deps after the SDK arguments', async () => {
    const tool = defineTool(
      'context',
      { description: 'Echoes deps', inputSchema: z.object({ n: z.number() }) },
      ({ n }, ctx, deps) => ({
        content: [
          { type: 'text', text: `${n} ${ctx.mcpReq.method} ${deps.config.publicUrl.href}` },
        ],
      }),
    );
    const { client } = await serve(tool);

    const result = await client.callTool({ name: 'context', arguments: { n: 7 } });

    expect(textOf(result)).toBe(`7 tools/call ${PUBLIC_URL}`);
  });

  test('a resource that throws: a generic internal error with a reference', async () => {
    const resource = defineResource('leaky', 'test://leaky', {}, () => {
      throw new Error(LEAKY);
    });
    const { client, deps } = await serve(resource);

    const error = await client.readResource({ uri: 'test://leaky' }).catch((caught) => caught);

    expect(error).toMatchObject({ code: ProtocolErrorCode.InternalError });
    expect(error.message).not.toContain('SECRET');
    expect(error.message).toContain(String(deps.logs[0]?.fields.reference));
  });

  test('a deliberate protocol error passes through unchanged and is not logged', async () => {
    const resource = defineResource('missing', 'test://missing', {}, (uri) => {
      throw new ResourceNotFoundError(uri.href);
    });
    const { client, deps } = await serve(resource);

    await expect(client.readResource({ uri: 'test://missing' })).rejects.toMatchObject({
      code: ProtocolErrorCode.InvalidParams,
      message: 'Resource not found: test://missing',
    });
    expect(deps.logs).toEqual([]);
  });

  test('a prompt that throws: a generic internal error with a reference', async () => {
    const prompt = definePrompt('leaky', { description: 'Fails' }, () => {
      throw new Error(LEAKY);
    });
    const { client } = await serve(prompt);

    const error = await client.getPrompt({ name: 'leaky' }).catch((caught) => caught);

    expect(error).toMatchObject({ code: ProtocolErrorCode.InternalError });
    expect(error.message).not.toContain('SECRET');
  });
});
