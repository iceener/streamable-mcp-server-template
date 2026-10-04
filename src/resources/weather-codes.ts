import { ResourceNotFoundError, ResourceTemplate } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { defineResource } from '../platform/primitives';
import { WEATHER_CODES } from '../services/weather';

const CODES = [...WEATHER_CODES.keys()].map(String);
const Variables = z.object({ code: z.enum(CODES) });

const uriFor = (code: string) => `weather://codes/${code}`;

/**
 * A resource template: one URI pattern, many resources. `list` and `complete` offer exactly
 * the URIs that `read` serves, and variables are validated before use.
 */
export const weatherCodes = defineResource(
  'weather-code',
  new ResourceTemplate('weather://codes/{code}', {
    list: () => ({
      resources: [...WEATHER_CODES].map(([code, description]) => ({
        uri: uriFor(String(code)),
        name: `weather-code-${code}`,
        title: `${code}: ${description}`,
        mimeType: 'application/json',
      })),
    }),
    complete: {
      code: (value) => CODES.filter((code) => code.startsWith(value)),
    },
  }),
  {
    title: 'Weather code',
    description: 'The meaning of a WMO weather code, as used in forecasts.',
    mimeType: 'application/json',
    annotations: { audience: ['assistant'], priority: 0.3 },
    cacheHint: { ttlMs: 86_400_000, cacheScope: 'public' },
  },
  (uri, variables) => {
    const parsed = Variables.safeParse(variables);
    if (!parsed.success) throw new ResourceNotFoundError(uri.href);

    const code = Number(parsed.data.code);
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({ code, description: WEATHER_CODES.get(code) }),
        },
      ],
    };
  },
);
