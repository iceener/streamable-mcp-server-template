import { defineResource } from '../platform/primitives';

const GUIDE = `# Using this server

- **get-forecast** — current conditions and a daily forecast for a city. Add the country
  when a name is ambiguous ("Portland, United States").
- **echo** — returns its input; useful to check the connection.
- **whoami** — shows which client and scopes this connection was authorized with.
- **confirm-action** — asks the user to approve an action before it runs.

Weather conditions follow the WMO codes listed under \`weather://codes/{code}\`.
`;

/** A static resource: fixed URI, fixed content, cacheable by every client. */
export const guide = defineResource(
  'guide',
  'docs://server/guide',
  {
    title: 'Server guide',
    description: 'What each tool does and when to use it.',
    mimeType: 'text/markdown',
    annotations: { audience: ['assistant', 'user'], priority: 0.8 },
    cacheHint: { ttlMs: 3_600_000, cacheScope: 'public' },
  },
  (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: GUIDE }],
  }),
);
