import { completable } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { definePrompt } from '../platform/primitives';

const STYLES = ['brief', 'detailed'] as const;

/**
 * A prompt template with argument completion. Prompt arguments travel as strings, so every
 * argument is a string (or a string enum) and optional ones say what happens when omitted.
 */
export const weatherBriefing = definePrompt(
  'weather-briefing',
  {
    title: 'Weather briefing',
    description: 'Write a practical weather briefing for a city.',
    argsSchema: z.object({
      city: z.string().min(1).max(100).describe('City to brief on'),
      style: completable(z.enum(STYLES).describe('"brief" (default) or "detailed"'), (value) =>
        STYLES.filter((style) => style.startsWith(value)),
      ).optional(),
    }),
  },
  ({ city, style = 'brief' }) => ({
    description: `A ${style} weather briefing for ${city}`,
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text:
            `Use the get-forecast tool for ${city}, then write a ${style} weather briefing. ` +
            'Lead with what to wear and whether to carry an umbrella, then summarize the coming days.',
        },
      },
    ],
  }),
);
