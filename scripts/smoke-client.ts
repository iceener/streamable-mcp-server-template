import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

/**
 * Drive a running server over real sockets with the official client, in both protocol
 * eras. Shared by the Bun and Workers smoke tests; it needs no network beyond loopback,
 * so it sticks to tools that do not call upstream APIs.
 */
export async function smoke(endpoint: URL, label: string): Promise<void> {
  assert.equal(endpoint.hostname, '127.0.0.1', 'smoke traffic stays on loopback');

  const health = await fetch(new URL('/health', endpoint));
  assert.equal(health.status, 200);

  for (const era of ['modern', 'legacy'] as const) {
    const client = new Client(
      { name: 'smoke', version: '1.0.0' },
      { versionNegotiation: { mode: era === 'modern' ? 'auto' : 'legacy' } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(endpoint, {
        fetch: async (url, init) => {
          const response = await fetch(url, { ...init, redirect: 'error' });
          assert.equal(response.headers.has('Mcp-Session-Id'), false, 'the server is stateless');
          return response;
        },
      }),
    );
    try {
      assert.equal(client.getProtocolEra(), era);
      const { tools } = await client.listTools();
      assert.ok(tools.some((tool) => tool.name === 'echo'));

      const echo = await client.callTool({ name: 'echo', arguments: { text: label } });
      assert.deepEqual(echo.structuredContent, { text: label });

      const guide = await client.readResource({ uri: 'docs://server/guide' });
      assert.equal(guide.contents.length, 1);

      const prompt = await client.getPrompt({
        name: 'weather-briefing',
        arguments: { city: 'Oslo' },
      });
      assert.equal(prompt.messages.length, 1);
    } finally {
      await client.close();
    }
    console.info(`${label}: ${era} client passed`);
  }

  const foreignOrigin = await fetch(endpoint, {
    method: 'POST',
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(foreignOrigin.status, 403);

  const oversized = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(700));
        controller.enqueue(new Uint8Array(700));
        controller.close();
      },
    }),
  });
  assert.equal(oversized.status, 413);
  console.info(`${label}: Origin guard and streamed body limit passed`);
}

if (import.meta.main) {
  const [endpoint, label = 'server'] = process.argv.slice(2);
  assert.ok(endpoint, 'usage: bun scripts/smoke-client.ts <loopback MCP URL> [label]');
  await smoke(new URL(endpoint), label);
}
