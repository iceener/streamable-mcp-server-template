import { completable, type McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppConfig } from '../../config/env.js';
import { serverIcons } from '../../config/metadata.js';

const supportedLanguages = ['en', 'es', 'fr', 'de'] as const;
const greetings: Record<(typeof supportedLanguages)[number], string> = {
  en: 'Hello',
  es: 'Hola',
  fr: 'Bonjour',
  de: 'Hallo',
};

const GreetingArgs = z.object({
  name: z.string().min(1).max(200).describe('Name to greet'),
  language: completable(
    z.enum(supportedLanguages).describe('Greeting language'),
    (value) => supportedLanguages.filter((language) => language.startsWith(value)),
  ).optional(),
});

const AnalysisArgs = z.object({
  topic: z.string().min(1).max(2_000).describe('Topic to analyze'),
  depth: z.enum(['basic', 'intermediate', 'advanced']).default('intermediate'),
  includeExamples: z.boolean().default(true),
});

const depthInstructions = {
  basic: 'Give a concise overview and define the essential concepts.',
  intermediate: 'Explain relationships, trade-offs, and practical considerations.',
  advanced: 'Cover edge cases, failure modes, and expert-level trade-offs.',
} as const;

export function registerPrompts(server: McpServer, config: AppConfig): void {
  const icons = serverIcons(config);

  server.registerPrompt(
    'greeting',
    {
      title: 'Greeting',
      description: 'Generate a short greeting in a selected language.',
      argsSchema: GreetingArgs,
      icons,
    },
    async ({ name, language = 'en' }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `${greetings[language]}, ${name}!`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'analysis',
    {
      title: 'Structured Analysis',
      description: 'Create a structured analysis request with configurable depth.',
      argsSchema: AnalysisArgs,
      icons,
    },
    async ({ topic, depth, includeExamples }) => ({
      description: `Analyze ${topic} at ${depth} depth`,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Analyze “${topic}”.`,
              depthInstructions[depth],
              includeExamples
                ? 'Include focused examples where they clarify a trade-off.'
                : 'Do not include examples.',
              'Structure the answer as context, key findings, risks, and recommendations.',
            ].join(' '),
          },
        },
      ],
    }),
  );
}
