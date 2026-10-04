import { afterEach, describe, expect, test } from 'bun:test';
import { ProtocolErrorCode } from '@modelcontextprotocol/server';
import { cleanup, connect } from './helpers';

afterEach(cleanup);

describe('weather-briefing', () => {
  test('every argument can be set with the strings clients send', async () => {
    const client = await connect();
    const { messages } = await client.getPrompt({
      name: 'weather-briefing',
      arguments: { city: 'Oslo', style: 'detailed' },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toMatchObject({ type: 'text' });
    expect(JSON.stringify(messages[0]?.content)).toContain('detailed weather briefing');
  });

  test('optional arguments have documented defaults', async () => {
    const client = await connect();
    const { description } = await client.getPrompt({
      name: 'weather-briefing',
      arguments: { city: 'Oslo' },
    });

    expect(description).toBe('A brief weather briefing for Oslo');
  });

  test('advertises its arguments and completes the style', async () => {
    const client = await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.find((prompt) => prompt.name === 'weather-briefing')?.arguments).toEqual([
      expect.objectContaining({ name: 'city', required: true }),
      expect.objectContaining({ name: 'style', required: false }),
    ]);

    const { completion } = await client.complete({
      ref: { type: 'ref/prompt', name: 'weather-briefing' },
      argument: { name: 'style', value: 'd' },
    });
    expect(completion.values).toEqual(['detailed']);
  });

  test('invalid arguments are rejected as invalid params', async () => {
    const client = await connect();
    await expect(
      client.getPrompt({ name: 'weather-briefing', arguments: { city: 'Oslo', style: 'long' } }),
    ).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });
  });
});
