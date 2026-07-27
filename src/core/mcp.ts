import {
  type McpRequestContext,
  McpServer,
  type ServerCapabilities,
} from '@modelcontextprotocol/server';
import type { AppConfig } from '../config/env.js';
import { serverImplementation } from '../config/metadata.js';
import { registerPrompts } from '../shared/prompts/index.js';
import { registerResources } from '../shared/resources/index.js';
import { registerTools } from '../shared/tools/registry.js';

export interface McpServerDependencies {
  runtimeName: string;
}

function capabilitiesFor(context: McpRequestContext): ServerCapabilities {
  const changeStreams = context.era === 'modern';
  return {
    tools: { listChanged: changeStreams },
    prompts: { listChanged: changeStreams },
    resources: {
      listChanged: changeStreams,
      subscribe: changeStreams,
    },
  };
}

/** Build a fresh MCP server for one HTTP request. */
export function createMcpServer(
  config: AppConfig,
  context: McpRequestContext,
  dependencies: McpServerDependencies,
): McpServer {
  const server = new McpServer(serverImplementation(config), {
    instructions: config.MCP_INSTRUCTIONS,
    capabilities: capabilitiesFor(context),
    cacheHints: {
      'server/discover': { ttlMs: 60_000, cacheScope: 'private' },
      'tools/list': { ttlMs: 60_000, cacheScope: 'private' },
      'prompts/list': { ttlMs: 60_000, cacheScope: 'private' },
      'resources/list': { ttlMs: 60_000, cacheScope: 'private' },
      'resources/templates/list': {
        ttlMs: 60_000,
        cacheScope: 'private',
      },
      'resources/read': { ttlMs: 0, cacheScope: 'private' },
    },
  });

  registerTools(server, config, {
    runtimeName: dependencies.runtimeName,
    era: context.era,
  });
  registerPrompts(server, config);
  registerResources(server, config);

  return server;
}
