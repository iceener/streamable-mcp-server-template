import * as z from 'zod/v4';

/**
 * Settings your own code needs: API keys, feature flags, upstream URLs. They are read from
 * the environment and validated at startup together with the platform's configuration, so
 * one misconfigured deploy reports every problem at once. Code reads them as
 * `deps.config.settings`.
 *
 * On Workers, store secrets with `wrangler secret put NAME --env production`, not in `vars`.
 */
export const Settings = z.object({
  OPEN_METEO_API_KEY: z
    .string()
    .optional()
    .describe('Open-Meteo commercial API key. The free API needs none.'),
});

export type Settings = z.infer<typeof Settings>;
