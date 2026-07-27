import {
  createMcpHandler,
  type McpHttpHandler,
  type ServerEventBus,
} from '@modelcontextprotocol/server';
import type { AppConfig } from '../config/env.js';
import { sharedLogger as logger } from '../shared/utils/logger.js';
import { createMcpServer } from './mcp.js';

export interface RuntimeDependencies {
  runtimeName: string;
  eventBus?: ServerEventBus;
}

export type McpRuntime = McpHttpHandler;

/**
 * Create one deployment-scoped HTTP handler. The handler owns the event bus and
 * active exchanges; its factory creates a new McpServer for every request.
 */
export function createMcpRuntime(
  config: AppConfig,
  dependencies: RuntimeDependencies,
): McpRuntime {
  return createMcpHandler(
    (context) =>
      createMcpServer(config, context, {
        runtimeName: dependencies.runtimeName,
      }),
    {
      legacy: config.MCP_LEGACY_MODE,
      responseMode: 'auto',
      ...(dependencies.eventBus ? { bus: dependencies.eventBus } : {}),
      onerror(error) {
        logger.error('mcp', {
          message: 'MCP request failed',
          error: error.message,
        });
      },
    },
  );
}
