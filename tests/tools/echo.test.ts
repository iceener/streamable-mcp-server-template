import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, connect, textOf } from '../helpers';

afterEach(cleanup);

describe('echo', () => {
  test('returns the text as content and structured output', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'echo', arguments: { text: 'hello' } });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe('hello');
    expect(result.structuredContent).toEqual({ text: 'hello' });
  });

  test('rejects input that fails the schema, as a tool error the model can read', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'echo', arguments: { text: '' } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('text');
  });

  test('advertises schemas and annotations', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const echo = tools.find((tool) => tool.name === 'echo');

    expect(echo?.inputSchema.required).toEqual(['text']);
    expect(echo?.outputSchema?.properties).toHaveProperty('text');
    expect(echo?.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
  });
});
