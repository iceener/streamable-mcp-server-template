import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

/** Official client over real HTTP sockets, shared by the Bun and workerd smokes. */
export async function smokeClient(endpoint: URL, runtimeName: string): Promise<void> {
  assert.equal(
    endpoint.hostname,
    '127.0.0.1',
    'Smoke traffic must stay on literal loopback',
  );
  assert.equal(endpoint.protocol, 'http:');
  const health = await fetch(new URL('/health', endpoint));
  assert.equal(health.status, 200);
  assert.equal((await health.json()).runtime, runtimeName);

  for (const mode of ['modern', 'legacy'] as const) {
    let sawSse = false;
    let sawLegacyGet405 = false;
    const client = new Client(
      { name: 'local-smoke', version: '1.0.0' },
      mode === 'modern'
        ? { versionNegotiation: { mode: { pin: '2026-07-28' } } }
        : undefined,
    );
    try {
      await client.connect(
        new StreamableHTTPClientTransport(endpoint, {
          fetch: async (url, init) => {
            assert.equal(new URL(String(url)).origin, endpoint.origin);
            const requestHeaders = new Headers(init?.headers);
            assert.equal(requestHeaders.has('Mcp-Session-Id'), false);
            if (requestHeaders.get('MCP-Protocol-Version') === '2026-07-28') {
              assert.ok(requestHeaders.get('Mcp-Method'));
            }
            const response = await fetch(url, { ...init, redirect: 'error' });
            assert.equal(response.headers.has('Mcp-Session-Id'), false);
            sawSse ||=
              response.headers.get('Content-Type')?.startsWith('text/event-stream') ??
              false;
            sawLegacyGet405 ||= init?.method === 'GET' && response.status === 405;
            return response;
          },
        }),
      );
      assert.equal(client.getProtocolEra(), mode);
      assert.equal(
        client.getNegotiatedProtocolVersion(),
        mode === 'modern' ? '2026-07-28' : '2025-11-25',
      );
      assert.equal(client.getServerVersion()?.name, 'mcp-server-template');
      assert.deepEqual(
        (await client.listTools()).tools.map((tool) => tool.name),
        ['echo', 'health'],
      );
      const progress: number[] = [];
      const result = await client.callTool(
        {
          name: 'echo',
          arguments: {
            message: 'socket',
            uppercase: true,
            delayMs: 30,
            steps: 3,
          },
        },
        {
          onprogress: (event) => {
            progress.push(event.progress);
          },
        },
      );
      assert.deepEqual(result.structuredContent, {
        echoed: 'SOCKET',
        length: 6,
        steps: 3,
      });
      assert.deepEqual(progress, [1, 2, 3]);
      assert.ok(sawSse, 'Progress must travel over real SSE');
      assert.ok(
        (await client.listPrompts()).prompts.some(
          (prompt) => prompt.name === 'greeting',
        ),
      );
      assert.ok(
        (await client.getPrompt({ name: 'greeting', arguments: { name: 'Ada' } }))
          .messages.length,
      );
      assert.ok((await client.listResources()).resources.length);
      assert.ok((await client.listResourceTemplates()).resourceTemplates.length);
      assert.ok(
        (await client.readResource({ uri: 'example://items/books/1' })).contents.length,
      );
      assert.deepEqual(
        (
          await client.complete({
            ref: { type: 'ref/prompt', name: 'greeting' },
            argument: { name: 'language', value: 'e' },
          })
        ).completion.values,
        ['en', 'es'],
      );
      if (mode === 'modern') {
        const subscription = await client.listen({ toolsListChanged: true });
        assert.deepEqual(subscription.honoredFilter, { toolsListChanged: true });
        await subscription.close();
        assert.equal(await subscription.closed, 'local');
      } else {
        assert.ok(sawLegacyGet405);
        assert.equal(client.getServerCapabilities()?.resources?.subscribe, false);
      }
    } finally {
      await client.close();
    }
    console.info(`${runtimeName}: ${mode} official-client socket smoke passed`);
  }

  const discover = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'server/discover',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  assert.equal(discover.status, 200);
  const wire = await discover.json();
  assert.equal(wire.result.serverInfo, undefined);
  assert.equal(
    wire.result._meta['io.modelcontextprotocol/serverInfo'].name,
    'mcp-server-template',
  );
  const rejectedOrigin = await fetch(endpoint, {
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(rejectedOrigin.status, 403);
  const tooLarge = await fetch(endpoint, {
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
  assert.equal(tooLarge.status, 413);
  console.info(
    `${runtimeName}: raw stable metadata, Origin and streamed body-bound checks passed`,
  );
}

if (import.meta.main) {
  const endpoint = process.argv[2];
  assert.ok(endpoint, 'Usage: bun scripts/smoke-client.ts <loopback MCP URL>');
  const timeout = setTimeout(() => {
    console.error('Socket smoke timed out');
    process.exit(1);
  }, 30_000);
  try {
    await smokeClient(new URL(endpoint), 'cloudflare-workers');
  } finally {
    clearTimeout(timeout);
  }
}
