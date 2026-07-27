import {
  type McpServer,
  ResourceNotFoundError,
  ResourceTemplate,
} from '@modelcontextprotocol/server';
import type { AppConfig } from '../../config/env.js';
import { SERVER_ICON_SVG, serverIcons } from '../../config/metadata.js';

const collections = ['books', 'movies', 'music'] as const;
const itemIds = ['1', '2', '3'] as const;

const templateGuide = `# MCP server template

This server uses the v2 TypeScript SDK and the stateless 2026-07-28 protocol.

- Tools use complete Standard Schema objects (Zod v4 in this template).
- Modern HTTP requests are independent and carry protocol metadata per request.
- Cancellation uses the HTTP request stream; progress stays on that request's SSE response.
- OAuth, when enabled, is enforced at the Resource Server boundary.
`;

export function registerResources(server: McpServer, config: AppConfig): void {
  const icons = serverIcons(config);

  server.registerResource(
    'template-guide',
    'docs://mcp-template/guide',
    {
      title: 'Template Guide',
      description: 'A concise guide to this MCP server template.',
      mimeType: 'text/markdown',
      icons,
      annotations: { audience: ['user', 'assistant'], priority: 0.8 },
      cacheHint: { ttlMs: 3_600_000, cacheScope: 'public' },
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          name: 'template-guide.md',
          title: 'Template Guide',
          mimeType: 'text/markdown',
          text: templateGuide,
        },
      ],
    }),
  );

  server.registerResource(
    'server-icon',
    'asset://mcp-template/icon.svg',
    {
      title: 'Server Icon',
      description: 'The SVG icon advertised in MCP metadata.',
      mimeType: 'image/svg+xml',
      icons,
      annotations: { audience: ['user', 'assistant'], priority: 0.3 },
      cacheHint: { ttlMs: 86_400_000, cacheScope: 'public' },
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          name: 'icon.svg',
          title: 'Server Icon',
          mimeType: 'image/svg+xml',
          text: SERVER_ICON_SVG,
        },
      ],
    }),
  );

  const itemTemplate = new ResourceTemplate('example://items/{collection}/{id}', {
    list: async () => ({
      resources: [
        { collection: 'books', id: '1' },
        { collection: 'books', id: '2' },
        { collection: 'movies', id: '1' },
      ].map(({ collection, id }) => ({
        uri: `example://items/${collection}/${id}`,
        name: `${collection}-${id}.json`,
        title: `${collection} ${id}`,
        description: 'Example templated JSON resource.',
        mimeType: 'application/json',
        icons,
      })),
    }),
    complete: {
      collection: async (value) =>
        collections.filter((collection) => collection.startsWith(value)),
      id: async (value) => itemIds.filter((id) => id.startsWith(value)),
    },
  });

  server.registerResource(
    'example-item',
    itemTemplate,
    {
      title: 'Example Item',
      description: 'Read an example item by collection and ID.',
      mimeType: 'application/json',
      icons,
      annotations: { audience: ['assistant'], priority: 0.5 },
      cacheHint: { ttlMs: 60_000, cacheScope: 'public' },
    },
    async (uri, variables) => {
      const collection = String(variables.collection);
      const id = String(variables.id);
      if (
        !collections.includes(collection as (typeof collections)[number]) ||
        !itemIds.includes(id as (typeof itemIds)[number])
      ) {
        throw new ResourceNotFoundError(uri.href);
      }

      return {
        contents: [
          {
            uri: uri.href,
            name: `${collection}-${id}.json`,
            title: `${collection} ${id}`,
            mimeType: 'application/json',
            text: JSON.stringify({ collection, id, ok: true }),
          },
        ],
      };
    },
  );
}
