import { McpServer, type McpServerFactory, requireScopes } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { defineTool } from '../src/platform/primitives';
import type { Deps } from '../src/server';

/**
 * A minimal server for the template's own HTTP, auth and SDK contract tests, so those
 * tests keep passing whatever tools a project replaces the samples with.
 */
export const FIXTURE = { name: 'fixture', version: '1.0.0' };

export const probe = defineTool(
  'probe',
  { description: 'Returns its input.', inputSchema: z.object({ text: z.string() }) },
  ({ text }) => ({ content: [{ type: 'text', text }] }),
);

/** Reports everything a handler can see about the caller. */
const caller = defineTool('caller', { description: 'Returns the caller.' }, (ctx) => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        authInfo: ctx.http?.authInfo ?? null,
        authorization: ctx.http?.req?.headers.get('Authorization') ?? null,
      }),
    },
  ],
}));

const scoped = defineTool(
  'scoped',
  { description: 'Needs probe:write.', scopeChallenge: requireScopes('probe:write') },
  () => ({ content: [{ type: 'text', text: 'ok' }] }),
);

export function fixtureServer(deps: Deps): McpServerFactory {
  return () => {
    const server = new McpServer(FIXTURE);
    for (const definition of [probe, caller, scoped]) definition.register(server, deps);
    return server;
  };
}
