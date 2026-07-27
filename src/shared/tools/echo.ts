import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppConfig } from '../../config/env.js';
import { serverIcons } from '../../config/metadata.js';

const EchoInput = z.object({
  message: z.string().min(1).max(10_000).describe('Message to echo'),
  uppercase: z.boolean().default(false).describe('Convert the message to uppercase'),
  delayMs: z
    .number()
    .int()
    .min(0)
    .max(5_000)
    .default(0)
    .describe('Optional simulated work duration in milliseconds'),
  steps: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(1)
    .describe('Progress steps used while delayed'),
});

const EchoOutput = z.object({
  echoed: z.string(),
  length: z.number().int().nonnegative(),
  steps: z.number().int().positive(),
});

function cancellationError(): Error {
  const error = new Error('Request cancelled');
  error.name = 'AbortError';
  return error;
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw cancellationError();

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(cancellationError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function reportProgress(
  ctx: ServerContext,
  progress: number,
  total: number,
): Promise<void> {
  const progressToken = ctx.mcpReq._meta?.progressToken;
  if (progressToken === undefined) return;

  await ctx.mcpReq.notify({
    method: 'notifications/progress',
    params: {
      progressToken,
      progress,
      total,
      message: `Completed step ${progress} of ${total}`,
    },
  });
}

export function registerEchoTool(server: McpServer, config: AppConfig): void {
  server.registerTool(
    'echo',
    {
      title: 'Echo Message',
      description:
        'Echo a message. Optional delay and progress steps demonstrate MCP progress and cancellation.',
      inputSchema: EchoInput,
      outputSchema: EchoOutput,
      icons: serverIcons(config),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ message, uppercase, delayMs, steps }, ctx) => {
      if (delayMs > 0) {
        const stepDelay = delayMs / steps;
        for (let step = 1; step <= steps; step += 1) {
          await abortableDelay(stepDelay, ctx.mcpReq.signal);
          await reportProgress(ctx, step, steps);
        }
      }

      const echoed = uppercase ? message.toUpperCase() : message;
      const output = { echoed, length: echoed.length, steps };

      return {
        content: [{ type: 'text', text: echoed }],
        structuredContent: output,
      };
    },
  );
}
