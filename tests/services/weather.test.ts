import { describe, expect, test } from 'bun:test';
import { createWeatherService, UpstreamError } from '../../src/services/weather';
import { KRAKOW } from '../helpers';

const GEOCODING = {
  results: [
    {
      name: 'Kraków',
      admin1: 'Lesser Poland',
      country: 'Poland',
      country_code: 'PL',
      latitude: 50.06,
      longitude: 19.94,
      timezone: 'Europe/Warsaw',
    },
  ],
};

/** A fetch that records requested URLs and answers with `respond`. */
function fakeFetch(respond: (url: URL, signal: AbortSignal) => Response | Promise<Response>) {
  const urls: URL[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    urls.push(url);
    return respond(url, init?.signal ?? new AbortController().signal);
  }) as typeof globalThis.fetch;
  return { fetch, urls };
}

const signal = () => new AbortController().signal;

describe('weather service', () => {
  test('uses the free endpoints without a key', async () => {
    const { fetch, urls } = fakeFetch(() => Response.json(GEOCODING));
    const place = await createWeatherService({ fetch }).findPlace('Kraków', signal());

    expect(place).toEqual(KRAKOW);
    expect(urls[0]?.origin).toBe('https://geocoding-api.open-meteo.com');
    expect(urls[0]?.searchParams.has('apikey')).toBe(false);
  });

  test('uses the customer endpoints with a key', async () => {
    const { fetch, urls } = fakeFetch(() => Response.json(GEOCODING));
    await createWeatherService({ fetch, apiKey: 'k' }).findPlace('Kraków', signal());

    expect(urls[0]?.origin).toBe('https://customer-geocoding-api.open-meteo.com');
    expect(urls[0]?.searchParams.get('apikey')).toBe('k');
  });

  test('prefers a match in the named country', async () => {
    const { fetch, urls } = fakeFetch(() =>
      Response.json({
        results: [
          { ...GEOCODING.results[0], name: 'Paris', country: 'United States', country_code: 'US' },
          { ...GEOCODING.results[0], name: 'Paris', country: 'France', country_code: 'FR' },
        ],
      }),
    );
    const place = await createWeatherService({ fetch }).findPlace('Paris, France', signal());

    expect(place?.country).toBe('France');
    expect(urls[0]?.searchParams.get('name')).toBe('Paris');
  });

  test('an error status is an outage', async () => {
    const { fetch } = fakeFetch(() => new Response('busy', { status: 503 }));
    const failure = createWeatherService({ fetch }).findPlace('Kraków', signal());

    await expect(failure).rejects.toBeInstanceOf(UpstreamError);
    await expect(failure).rejects.toMatchObject({ status: 503 });
  });

  test('a body that stalls past the timeout is an outage', async () => {
    // Like a real fetch, the body fails when the request's signal aborts.
    const { fetch } = fakeFetch(
      (_url, requestSignal) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"results":'));
              requestSignal.addEventListener('abort', () => controller.error(requestSignal.reason));
            },
          }),
        ),
    );
    const failure = createWeatherService({ fetch, timeoutMs: 50 }).findPlace('Kraków', signal());

    await expect(failure).rejects.toBeInstanceOf(UpstreamError);
  });

  test('a complete response in the wrong shape is a bug, not an outage', async () => {
    const { fetch } = fakeFetch(() => Response.json({ results: [{ name: 42 }] }));
    const failure = createWeatherService({ fetch }).findPlace('Kraków', signal());

    await expect(failure).rejects.not.toBeInstanceOf(UpstreamError);
  });

  test('cancellation is passed on unchanged', async () => {
    const controller = new AbortController();
    const { fetch } = fakeFetch(
      (_url, requestSignal) =>
        new Promise((_, reject) => {
          requestSignal.addEventListener('abort', () => reject(requestSignal.reason));
        }),
    );
    const failure = createWeatherService({ fetch }).findPlace('Kraków', controller.signal);
    controller.abort(new Error('stop'));

    await expect(failure).rejects.toThrow('stop');
    await expect(failure).rejects.not.toBeInstanceOf(UpstreamError);
  });
});
