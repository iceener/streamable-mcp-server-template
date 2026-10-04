import { afterEach, describe, expect, test } from 'bun:test';
import { UpstreamError } from '../../src/services/weather';
import { cleanup, connect, fakeWeather, forecastFor, KRAKOW, testDeps, textOf } from '../helpers';

afterEach(cleanup);

describe('get-forecast', () => {
  test('returns a summary and structured forecast, reporting progress per step', async () => {
    const client = await connect();
    const progress: Array<[number, number | undefined]> = [];

    const result = await client.callTool(
      { name: 'get-forecast', arguments: { city: 'Kraków', days: 2 } },
      { onprogress: ({ progress: done, total }) => progress.push([done, total]) },
    );

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(forecastFor(KRAKOW, 2));
    expect(textOf(result)).toStartWith('Kraków, Lesser Poland, Poland — now 14 °C');
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  test('tells the model how to recover when the city is unknown', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'get-forecast', arguments: { city: 'Atlantis' } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('No place named "Atlantis"');
  });

  test('reports an upstream outage as retryable and logs it as a warning', async () => {
    const deps = testDeps({
      weather: fakeWeather({
        getForecast: async () => {
          throw new UpstreamError('Open-Meteo', 503);
        },
      }),
    });
    const client = await connect({ deps });
    const result = await client.callTool({ name: 'get-forecast', arguments: { city: 'Kraków' } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Try again in a minute');
    expect(deps.logs.map(({ level, message }) => [level, message])).toEqual([
      ['warning', 'Weather service unavailable'],
    ]);
  });

  test('a cancelled call aborts the upstream request', async () => {
    let upstreamSignal: AbortSignal | undefined;
    const deps = testDeps({
      weather: fakeWeather({
        findPlace: (_query, signal) => {
          upstreamSignal = signal;
          return new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      }),
    });
    const client = await connect({ deps });
    const controller = new AbortController();

    const call = client.callTool(
      { name: 'get-forecast', arguments: { city: 'Kraków' } },
      { signal: controller.signal },
    );
    while (!upstreamSignal) await Bun.sleep(1);
    controller.abort('stop');

    await expect(call).rejects.toThrow();
    await Bun.sleep(10);
    expect(upstreamSignal.aborted).toBe(true);
    // Cancellation is not a failure: nothing is logged.
    expect(deps.logs).toEqual([]);
  });
});
