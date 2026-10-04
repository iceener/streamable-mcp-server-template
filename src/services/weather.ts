import * as z from 'zod/v4';

/**
 * Open-Meteo client (https://open-meteo.com). Free, no API key, global coverage.
 *
 * Services know nothing about MCP. They take an `AbortSignal` so a cancelled tool call
 * stops its upstream requests, validate every response, and throw `UpstreamError` when the
 * provider is down, slow or failing. A service that needs a credential reads it from
 * `Config`, never from the caller's MCP token: that token was issued for this server only.
 */
export interface WeatherService {
  /** The best match for a city name, or `undefined` when nothing matches. */
  findPlace(query: string, signal: AbortSignal): Promise<Place | undefined>;
  getForecast(place: Place, days: number, signal: AbortSignal): Promise<Forecast>;
}

export interface Place {
  name: string;
  region: string | undefined;
  country: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

export interface Forecast {
  place: Place;
  current: {
    time: string;
    temperatureC: number;
    feelsLikeC: number;
    humidityPercent: number;
    windKmh: number;
    conditions: string;
  };
  daily: Array<{
    date: string;
    minC: number;
    maxC: number;
    precipitationChancePercent: number | null;
    conditions: string;
  }>;
}

/** The provider failed: an HTTP error status, a timeout, or a network failure. */
export class UpstreamError extends Error {
  constructor(
    readonly service: string,
    readonly status: number | undefined,
    options?: ErrorOptions,
  ) {
    super(
      status === undefined ? `${service} did not respond` : `${service} responded with ${status}`,
      options,
    );
    this.name = 'UpstreamError';
  }
}

export interface WeatherServiceOptions {
  /** Injected in tests. Defaults to the runtime's `fetch`. */
  fetch?: typeof fetch;
  /** Per-request upper bound, on top of the caller's cancellation. */
  timeoutMs?: number;
}

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

const GeocodingResponse = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        admin1: z.string().optional(),
        country: z.string().default(''),
        country_code: z.string().default(''),
        latitude: z.number(),
        longitude: z.number(),
        timezone: z.string().default('auto'),
      }),
    )
    .default([]),
});

const ForecastResponse = z.object({
  current: z.object({
    time: z.string(),
    temperature_2m: z.number(),
    apparent_temperature: z.number(),
    relative_humidity_2m: z.number(),
    wind_speed_10m: z.number(),
    weather_code: z.number().int(),
  }),
  daily: z.object({
    time: z.array(z.string()),
    temperature_2m_min: z.array(z.number()),
    temperature_2m_max: z.array(z.number()),
    precipitation_probability_max: z.array(z.number().nullable()),
    weather_code: z.array(z.number().int()),
  }),
});

export function createWeatherService(options: WeatherServiceOptions = {}): WeatherService {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function getJson<T>(url: URL, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch (error) {
      if (signal.aborted) throw error; // The caller cancelled: not the provider's fault.
      throw new UpstreamError('Open-Meteo', undefined, { cause: error });
    }
    if (!response.ok) throw new UpstreamError('Open-Meteo', response.status);
    // A response that does not match the schema is a bug to fix, not an outage: let it throw.
    return schema.parse(await response.json());
  }

  return {
    async findPlace(query, signal) {
      // "Paris, France": search by name, then prefer a match in the named country.
      const [name = '', countryHint] = query.split(',').map((part) => part.trim());
      const url = new URL(GEOCODING_URL);
      url.search = new URLSearchParams({ name, count: '10', language: 'en' }).toString();

      const { results } = await getJson(url, GeocodingResponse, signal);
      const hint = countryHint?.toLowerCase();
      const match = hint
        ? results.find(
            (result) =>
              result.country.toLowerCase().startsWith(hint) ||
              result.country_code.toLowerCase() === hint,
          )
        : results[0];

      return (
        match && {
          name: match.name,
          region: match.admin1,
          country: match.country,
          latitude: match.latitude,
          longitude: match.longitude,
          timezone: match.timezone,
        }
      );
    },

    async getForecast(place, days, signal) {
      const url = new URL(FORECAST_URL);
      url.search = new URLSearchParams({
        latitude: String(place.latitude),
        longitude: String(place.longitude),
        timezone: place.timezone,
        forecast_days: String(days),
        current:
          'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code',
        daily: 'temperature_2m_min,temperature_2m_max,precipitation_probability_max,weather_code',
      }).toString();

      const { current, daily } = await getJson(url, ForecastResponse, signal);
      return {
        place,
        current: {
          time: current.time,
          temperatureC: current.temperature_2m,
          feelsLikeC: current.apparent_temperature,
          humidityPercent: current.relative_humidity_2m,
          windKmh: current.wind_speed_10m,
          conditions: describeWeatherCode(current.weather_code),
        },
        // Open-Meteo returns one array per variable; zip them, skipping incomplete days.
        daily: daily.time.flatMap((date, day) => {
          const minC = daily.temperature_2m_min[day];
          const maxC = daily.temperature_2m_max[day];
          const code = daily.weather_code[day];
          if (minC === undefined || maxC === undefined || code === undefined) return [];
          return [
            {
              date,
              minC,
              maxC,
              precipitationChancePercent: daily.precipitation_probability_max[day] ?? null,
              conditions: describeWeatherCode(code),
            },
          ];
        }),
      };
    },
  };
}

/** WMO weather interpretation codes, as used by Open-Meteo. */
export const WEATHER_CODES: ReadonlyMap<number, string> = new Map([
  [0, 'Clear sky'],
  [1, 'Mainly clear'],
  [2, 'Partly cloudy'],
  [3, 'Overcast'],
  [45, 'Fog'],
  [48, 'Depositing rime fog'],
  [51, 'Light drizzle'],
  [53, 'Moderate drizzle'],
  [55, 'Dense drizzle'],
  [56, 'Light freezing drizzle'],
  [57, 'Dense freezing drizzle'],
  [61, 'Slight rain'],
  [63, 'Moderate rain'],
  [65, 'Heavy rain'],
  [66, 'Light freezing rain'],
  [67, 'Heavy freezing rain'],
  [71, 'Slight snow fall'],
  [73, 'Moderate snow fall'],
  [75, 'Heavy snow fall'],
  [77, 'Snow grains'],
  [80, 'Slight rain showers'],
  [81, 'Moderate rain showers'],
  [82, 'Violent rain showers'],
  [85, 'Slight snow showers'],
  [86, 'Heavy snow showers'],
  [95, 'Thunderstorm'],
  [96, 'Thunderstorm with slight hail'],
  [99, 'Thunderstorm with heavy hail'],
]);

export function describeWeatherCode(code: number): string {
  return WEATHER_CODES.get(code) ?? 'Unknown conditions';
}
