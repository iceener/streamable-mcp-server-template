import { afterEach, describe, expect, test } from 'bun:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  createMcpHandler,
  McpServer,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
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

describe('resource templates', () => {
  test('list and complete callbacks that throw: a generic error with a reference', async () => {
    const template = new ResourceTemplate('test://items/{id}', {
      list: () => {
        throw new Error(LEAKY);
      },
      complete: {
        id: () => {
          throw new Error(LEAKY);
        },
      },
    });
    const resource = defineResource('items', template, {}, (uri) => ({
      contents: [{ uri: uri.href, text: 'item' }],
    }));
    const { client, deps } = await serve(resource);

    const listed = await client.listResources().catch((caught) => caught);
    const completed = await client
      .complete({
        ref: { type: 'ref/resource', uri: 'test://items/{id}' },
        argument: { name: 'id', value: '' },
      })
      .catch((caught) => caught);

    for (const error of [listed, completed]) {
      expect(error).toMatchObject({ code: ProtocolErrorCode.InternalError });
      expect(error.message).not.toContain('SECRET');
    }
    expect(deps.logs.map(({ message, fields }) => [message, fields.resource])).toEqual([
      ['Unexpected resource failure', 'items'],
      ['Unexpected resource failure', 'items'],
    ]);
  });

  test('a template can be built from deps, so list and complete can use services', async () => {
    const resource = defineResource(
      'places',
      (deps) =>
        new ResourceTemplate('test://places/{name}', {
          list: async () => ({
            resources: [{ uri: `test://places/${deps.config.publicUrl.hostname}`, name: 'host' }],
          }),
        }),
      {},
      (uri) => ({ contents: [{ uri: uri.href, text: 'place' }] }),
    );
    const { client } = await serve(resource);

    const { resources } = await client.listResources();
    expect(resources.map((entry) => entry.uri)).toEqual(['test://places/127.0.0.1']);
  });
});

describe('types', () => {
  test('structuredContent must match outputSchema, and is required with one', () => {
    const Count = z.object({ count: z.number() });
    defineTool(
      'typed',
      { description: 'Typed', outputSchema: Count },
      // @ts-expect-error "one" is not a number: `bun run typecheck` fails if this compiles.
      () => ({ content: [], structuredContent: { count: 'one' } }),
    );
    defineTool(
      'missing',
      { description: 'Typed', outputSchema: Count },
      // @ts-expect-error a successful result without structuredContent would fail at runtime.
      () => ({ content: [{ type: 'text', text: 'no data' }] }),
    );
    defineTool('failing', { description: 'Typed', outputSchema: Count }, () =>
      toolError('Error results need no structured content.'),
    );
  });
});
