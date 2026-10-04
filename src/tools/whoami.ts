import * as z from 'zod/v4';
import { defineTool } from '../platform/primitives';

/** Reads the verified caller. Tools never see the bearer token itself; see `platform/http.ts`. */
export const whoami = defineTool(
  'whoami',
  {
    title: 'Who am I',
    description:
      'Describe the authenticated caller: client ID, subject and granted scopes. ' +
      'Reports an anonymous caller when authentication is off.',
    outputSchema: z.object({
      authenticated: z.boolean(),
      clientId: z.string().optional(),
      subject: z.string().optional(),
      scopes: z.array(z.string()),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  (ctx) => {
    const caller = ctx.http?.authInfo;
    const subject = caller?.extra?.subject;
    const output = caller
      ? {
          authenticated: true,
          clientId: caller.clientId,
          ...(typeof subject === 'string' && { subject }),
          scopes: caller.scopes,
        }
      : { authenticated: false, scopes: [] };

    return {
      content: [{ type: 'text', text: JSON.stringify(output) }],
      structuredContent: output,
    };
  },
);
