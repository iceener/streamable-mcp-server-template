import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createLogger } from '../src/platform/logger';

let lines: Array<Record<string, unknown>>;

beforeEach(() => {
  lines = [];
  for (const method of ['debug', 'info', 'warn', 'error'] as const) {
    spyOn(console, method).mockImplementation((line: string) => {
      lines.push(JSON.parse(line));
    });
  }
});

afterEach(() => {
  for (const method of ['debug', 'info', 'warn', 'error'] as const) {
    (console[method] as unknown as { mockRestore(): void }).mockRestore();
  }
});

describe('logger', () => {
  test('writes one JSON object per entry, at or above the configured level', () => {
    const logger = createLogger('info');
    logger.debug('hidden');
    logger.info('shown', { requestId: 7 });
    logger.warning('also shown');

    expect(lines).toEqual([
      expect.objectContaining({ level: 'info', message: 'shown', requestId: 7 }),
      expect.objectContaining({ level: 'warning', message: 'also shown' }),
    ]);
    expect(lines[0]?.timestamp).toBeString();
  });

  test('child loggers add their fields to every entry', () => {
    createLogger('info', { service: 'mcp' }).child({ tool: 'echo' }).info('called');
    expect(lines[0]).toMatchObject({ service: 'mcp', tool: 'echo', message: 'called' });
  });

  test('redacts secrets by key, at any depth', () => {
    createLogger('info').info('request', {
      headers: { authorization: 'Bearer abc', 'x-api-key': 'k' },
      accessToken: 't',
      client_secret: 's',
      nested: [{ password: 'p' }],
      tokenizer: 'not a secret',
    });

    expect(lines[0]).toMatchObject({
      headers: { authorization: '[REDACTED]', 'x-api-key': '[REDACTED]' },
      accessToken: '[REDACTED]',
      client_secret: '[REDACTED]',
      nested: [{ password: '[REDACTED]' }],
      tokenizer: 'not a secret',
    });
  });

  test('redacts secrets inside values: bearer tokens, JWTs and credential query parameters', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
    createLogger('info').error('failed', {
      error: new Error(`GET https://api.example.com/v1?api_key=SECRET&q=1 with Bearer ${jwt}`),
    });

    const logged = JSON.stringify(lines[0]);
    expect(logged).not.toContain('SECRET');
    expect(logged).not.toContain(jwt);
    expect(logged).toContain('api_key=[REDACTED]&q=1');
  });

  test('serializes errors with their cause, and survives cycles', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    createLogger('info').error('failed', {
      error: new Error('outer', { cause: new TypeError('inner') }),
      cycle,
    });

    expect(lines[0]).toMatchObject({
      error: { name: 'Error', message: 'outer', cause: { name: 'TypeError', message: 'inner' } },
      cycle: { self: '[Circular]' },
    });
  });
});
