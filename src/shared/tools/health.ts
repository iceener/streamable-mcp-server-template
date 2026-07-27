import type { McpServer, ProtocolEra } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppConfig } from '../../config/env.js';
import { serverIcons } from '../../config/metadata.js';

const HealthInput = z.object({
  verbose: z.boolean().default(false).describe('Include non-sensitive request details'),
});

const HealthOutput = z.object({
  status: z.literal('ok'),
  timestamp: z.string(),
  runtime: z.string(),
  protocolEra: z.enum(['legacy', 'modern']),
  authenticated: z.boolean(),
  clientId: z.string().optional(),
  requestMethod: z.string().optional(),
});

export function registerHealthTool(
  server: McpServer,
  config: AppConfig,
  runtimeName: string,
  era: ProtocolEra,
): void {
  server.registerTool(
    'health',
    {
      title: 'Server Health',
      description: 'Report server health and non-sensitive request context.',
      inputSchema: HealthInput,
      outputSchema: HealthOutput,
      icons: serverIcons(config),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ verbose }, ctx) => {
      const authInfo = ctx.http?.authInfo;
      const output = {
        status: 'ok' as const,
        timestamp: new Date().toISOString(),
        runtime: runtimeName,
        protocolEra: era,
        authenticated: authInfo !== undefined,
        ...(authInfo ? { clientId: authInfo.clientId } : {}),
        ...(verbose ? { requestMethod: ctx.mcpReq.method } : {}),
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );
}
