import { afterEach, describe, expect, test } from 'bun:test';
import { ProtocolErrorCode } from '@modelcontextprotocol/server';
import { cleanup, connect } from './helpers';

afterEach(cleanup);

describe('resources', () => {
  test('the guide is a static markdown resource', async () => {
    const client = await connect();
    const { resources } = await client.listResources();
    expect(resources).toContainEqual(
      expect.objectContaining({ uri: 'docs://server/guide', mimeType: 'text/markdown' }),
    );

    const { contents } = await client.readResource({ uri: 'docs://server/guide' });
    expect(contents).toEqual([
      expect.objectContaining({ uri: 'docs://server/guide', mimeType: 'text/markdown' }),
    ]);
  });

  test('weather codes: list, read and complete agree', async () => {
    const client = await connect();
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((template) => template.uriTemplate)).toEqual([
      'weather://codes/{code}',
    ]);

    const { resources } = await client.listResources();
    const codes = resources.filter((resource) => resource.uri.startsWith('weather://codes/'));
    expect(codes).toHaveLength(28);

    for (const { uri } of codes) {
      const { contents } = await client.readResource({ uri });
      expect(contents[0]?.uri).toBe(uri);
    }

    const { contents } = await client.readResource({ uri: 'weather://codes/95' });
    expect(contents[0]).toEqual({
      uri: 'weather://codes/95',
      mimeType: 'application/json',
      text: JSON.stringify({ code: 95, description: 'Thunderstorm' }),
    });

    const { completion } = await client.complete({
      ref: { type: 'ref/resource', uri: 'weather://codes/{code}' },
      argument: { name: 'code', value: '6' },
    });
    expect(completion.values).toEqual(['61', '63', '65', '66', '67']);
  });

  test('an unknown code is a protocol error, not a server fault', async () => {
    const client = await connect();
    await expect(client.readResource({ uri: 'weather://codes/42' })).rejects.toMatchObject({
      code: ProtocolErrorCode.InvalidParams,
      message: 'Resource not found: weather://codes/42',
    });
  });
});
