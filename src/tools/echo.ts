import * as z from 'zod/v4';
import { defineTool } from '../platform/primitives';

/** The smallest complete tool: validated input, structured output, accurate annotations. */
export const echo = defineTool(
  'echo',
  {
    title: 'Echo',
    description: 'Return the given text unchanged. Use it to check that the server is reachable.',
    inputSchema: z.object({
      text: z.string().min(1).max(10_000).describe('Text to send back'),
    }),
    outputSchema: z.object({
      text: z.string().describe('The text that was sent'),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  ({ text }) => ({
    content: [{ type: 'text', text }],
    structuredContent: { text },
  }),
);
