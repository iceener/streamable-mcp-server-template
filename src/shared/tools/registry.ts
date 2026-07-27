import type { McpServer, ProtocolEra } from '@modelcontextprotocol/server';
import type { AppConfig } from '../../config/env.js';
import { registerEchoTool } from './echo.js';
import { registerHealthTool } from './health.js';

export interface ToolRegistrationOptions {
  runtimeName: string;
  era: ProtocolEra;
}

/** Register tools in deterministic order. */
export function registerTools(
  server: McpServer,
  config: AppConfig,
  options: ToolRegistrationOptions,
): void {
  registerEchoTool(server, config);
  registerHealthTool(server, config, options.runtimeName, options.era);
}
