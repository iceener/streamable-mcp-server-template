import * as z from 'zod/v4';
import { defineTool, reportProgress, toolError } from '../platform/primitives';
import { type Forecast, UpstreamError } from '../services/weather';

const Conditions = z.string().describe('Plain-language conditions, e.g. "Partly cloudy"');

const ForecastOutput = z.object({
  place: z.object({
    name: z.string(),
    region: z.string().optional(),
    country: z.string(),
    latitude: z.number(),
    longitude: z.number(),
    timezone: z.string(),
  }),
  current: z.object({
    time: z.string().describe('Local time of the observation'),
    temperatureC: z.number(),
    feelsLikeC: z.number(),
    humidityPercent: z.number(),
    windKmh: z.number(),
    conditions: Conditions,
  }),
  daily: z.array(
    z.object({
      date: z.string(),
      minC: z.number(),
      maxC: z.number(),
      precipitationChancePercent: z.number().nullable(),
      conditions: Conditions,
    }),
  ),
});

/**
 * Calls an upstream API through a service: forwards cancellation, reports progress,
 * and turns expected upstream failures into errors the model can act on.
 */
export const getForecast = defineTool(
  'get-forecast',
  {
    title: 'Get weather forecast',
    description: 'Current conditions and a daily forecast for a city. Data comes from Open-Meteo.',
    inputSchema: z.object({
      city: z
        .string()
        .min(1)
        .max(100)
        .describe('City name, optionally followed by a country: "Kraków" or "Paris, France"'),
      days: z.number().int().min(1).max(7).default(3).describe('Number of days to forecast'),
    }),
    outputSchema: ForecastOutput,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ city, days }, ctx, { weather, logger }) => {
    const { signal } = ctx.mcpReq;
    try {
      const place = await weather.findPlace(city, signal);
      if (!place) {
        return toolError(
          `No place named "${city}" was found. Check the spelling, add the country ` +
            '("Paris, France"), or try a larger nearby city.',
        );
      }
      await reportProgress(ctx, 1, 2, `Found ${place.name}, ${place.country}`);

      const forecast = await weather.getForecast(place, days, signal);
      await reportProgress(ctx, 2, 2, 'Forecast received');

      return {
        content: [{ type: 'text', text: summarize(forecast) }],
        structuredContent: forecast,
      };
    } catch (error) {
      // An outage is expected, not a bug: tell the model what to do, and the operator what happened.
      if (error instanceof UpstreamError) {
        logger.warning('Weather service unavailable', { error });
        return toolError('The weather service is unavailable right now. Try again in a minute.');
      }
      throw error;
    }
  },
);

function summarize({ place, current, daily }: Forecast): string {
  const location = [place.name, place.region, place.country].filter(Boolean).join(', ');
  const days = daily.map(
    (day) =>
      `- ${day.date}: ${day.conditions}, ${day.minC}–${day.maxC} °C` +
      (day.precipitationChancePercent === null
        ? ''
        : `, ${day.precipitationChancePercent}% chance of precipitation`),
  );
  return [
    `${location} — now ${current.temperatureC} °C (feels like ${current.feelsLikeC} °C), ` +
      `${current.conditions.toLowerCase()}, wind ${current.windKmh} km/h, ` +
      `humidity ${current.humidityPercent}%.`,
    ...days,
  ].join('\n');
}
