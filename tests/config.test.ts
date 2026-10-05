import { describe, expect, test } from 'bun:test';
import { DEFAULT_MAX_REQUEST_BODY_SIZE } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { type Config, ConfigError, parseConfig } from '../src/platform/config';
import type { Settings } from '../src/settings';

/**
 * These tests cover the platform's own variables, so they parse with a stub in place of
 * `src/settings.ts`: adding settings to your project never breaks them.
 */
const NO_SETTINGS = z.object({});

function parse(env: Record<string, unknown>, settings: z.ZodType = NO_SETTINGS): Config {
  return parseConfig(env, settings as unknown as z.ZodType<Settings>);
}

/** The problems `parseConfig` reports for `env`, or `[]` when it is valid. */
function problems(env: Record<string, unknown>, settings?: z.ZodType): string[] {
  try {
    parse(env, settings);
    return [];
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
}

const production = {
  NODE_ENV: 'production',
  MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
  AUTH_MODE: 'none',
};

const oauth = {
  AUTH_MODE: 'oauth',
  OAUTH_ISSUER_URL: 'https://auth.example.com',
  OAUTH_AUTHORIZATION_URL: 'https://auth.example.com/authorize',
  OAUTH_TOKEN_URL: 'https://auth.example.com/token',
  OAUTH_JWKS_URL: 'https://auth.example.com/jwks.json',
};

describe('defaults', () => {
  test('development works with no configuration at all', () => {
    const config = parse({});

    expect(config.environment).toBe('development');
    expect(config.publicUrl.href).toBe('http://127.0.0.1:3000/mcp');
    expect(config.allowedHosts).toEqual(['127.0.0.1', 'localhost', '[::1]']);
    expect(config.allowedOrigins).toEqual(config.allowedHosts);
    expect(config.legacy).toBe('stateless');
    expect(config.maxRequestBytes).toBe(DEFAULT_MAX_REQUEST_BODY_SIZE);
    expect(config.auth).toEqual({ mode: 'none' });
  });

  test('production allows only the public hostname by default', () => {
    expect(parse(production).allowedHosts).toEqual(['mcp.example.com']);
  });

  test('empty values count as unset, and non-string Worker bindings are ignored', () => {
    const config = parse({ PORT: '', LOG_LEVEL: '', KV: { get() {} } });
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe('info');
  });
});

describe('production', () => {
  test('requires an explicit public URL and auth decision, reported together', () => {
    expect(problems({ NODE_ENV: 'production' })).toEqual([
      'MCP_PUBLIC_URL is required in production',
      'AUTH_MODE is required in production: "oauth", "bearer", or "none" to serve without authentication',
    ]);
  });

  test('an invalid value does not hide the other problems', () => {
    const reported = problems({ NODE_ENV: 'production', PORT: 'eighty' });
    expect(reported).toHaveLength(3);
    expect(reported[0]).toStartWith('PORT:');
    expect(reported).toContain('MCP_PUBLIC_URL is required in production');
  });

  test('requires https everywhere', () => {
    expect(problems({ ...production, MCP_PUBLIC_URL: 'http://mcp.example.com/mcp' })).toEqual([
      'MCP_PUBLIC_URL must use https in production',
    ]);
  });
});

describe('public URL', () => {
  test('plain http is for loopback development only', () => {
    expect(problems({ MCP_PUBLIC_URL: 'http://localhost:8787/mcp' })).toEqual([]);
    expect(problems({ MCP_PUBLIC_URL: 'http://192.168.1.10/mcp' })).toEqual([
      'MCP_PUBLIC_URL may use http only for localhost, 127.0.0.1 or [::1]',
    ]);
  });

  test('must be written canonically, since it is compared as a string', () => {
    expect(problems({ MCP_PUBLIC_URL: 'https://MCP.example.com/mcp' })).toEqual([
      'MCP_PUBLIC_URL must be written in canonical form: "https://mcp.example.com/mcp"',
    ]);
    expect(problems({ MCP_PUBLIC_URL: 'https://mcp.example.com' })).toEqual([
      'MCP_PUBLIC_URL must be written in canonical form: "https://mcp.example.com/"',
    ]);
  });

  test('rejects queries, fragments, credentials, other schemes and non-URLs', () => {
    expect(problems({ MCP_PUBLIC_URL: 'https://mcp.example.com/mcp?x=1' })).toEqual([
      'MCP_PUBLIC_URL must not contain a query string',
    ]);
    expect(problems({ MCP_PUBLIC_URL: 'https://mcp.example.com/mcp#x' })).toContain(
      'MCP_PUBLIC_URL must not contain a fragment',
    );
    expect(problems({ MCP_PUBLIC_URL: 'https://user:pass@mcp.example.com/mcp' })).toContain(
      'MCP_PUBLIC_URL must not contain credentials',
    );
    expect(problems({ MCP_PUBLIC_URL: 'ftp://mcp.example.com/mcp' })).toContain(
      'MCP_PUBLIC_URL must use http or https',
    );
    expect(problems({ MCP_PUBLIC_URL: 'mcp.example.com/mcp' })).toEqual([
      'MCP_PUBLIC_URL must be an absolute URL, got "mcp.example.com/mcp"',
    ]);
  });
});

describe('allowlists', () => {
  test('the Host allowlist must include the public hostname', () => {
    expect(problems({ ...production, MCP_ALLOWED_HOSTS: 'internal.example.com' })).toEqual([
      'MCP_ALLOWED_HOSTS must include the public URL\'s hostname, "mcp.example.com"',
    ]);
  });

  test('entries are bare lowercase hostnames', () => {
    for (const entry of [
      'https://mcp.example.com',
      'mcp.example.com:443',
      'MCP.example.com',
      '*',
    ]) {
      expect(problems({ MCP_ALLOWED_HOSTS: `127.0.0.1,${entry}` })).toEqual([
        `MCP_ALLOWED_HOSTS entries are lowercase hostnames without scheme or port, got "${entry}"`,
      ]);
    }
    expect(parse({ MCP_ALLOWED_HOSTS: ' 127.0.0.1, [::1] ,127.0.0.1' }).allowedHosts).toEqual([
      '127.0.0.1',
      '[::1]',
    ]);
  });

  test('the Host check also covers the default public URL', () => {
    expect(problems({ MCP_ALLOWED_HOSTS: 'localhost' })).toEqual([
      'MCP_ALLOWED_HOSTS must include the public URL\'s hostname, "127.0.0.1"',
    ]);
  });

  test('origins may also admit every extension of a browser', () => {
    expect(parse({ MCP_ALLOWED_ORIGIN_HOSTNAMES: 'moz-extension://*' }).allowedOrigins).toEqual([
      'moz-extension://*',
    ]);
    expect(problems({ MCP_ALLOWED_ORIGIN_HOSTNAMES: 'https://*' })).toHaveLength(1);
    expect(problems({ MCP_ALLOWED_HOSTS: '127.0.0.1,moz-extension://*' })).toHaveLength(1);
  });
});

describe('oauth', () => {
  test('needs the authorization server endpoints; the key set is up to the verifier', () => {
    expect(problems({ AUTH_MODE: 'oauth' })).toEqual([
      'AUTH_MODE=oauth requires OAUTH_ISSUER_URL, OAUTH_AUTHORIZATION_URL, OAUTH_TOKEN_URL',
    ]);
    const { OAUTH_JWKS_URL: _, ...withoutKeySet } = oauth;
    expect(parse(withoutKeySet).auth).toMatchObject({ mode: 'oauth', jwksUrl: undefined });
  });

  test('keeps the issuer exactly as written', () => {
    const config = parse({ ...oauth, OAUTH_ISSUER_URL: 'https://auth.example.com/tenant/' });
    expect(config.auth).toMatchObject({
      mode: 'oauth',
      issuer: 'https://auth.example.com/tenant/',
    });
  });

  test('parses scopes, separated by spaces or commas, and checks their syntax', () => {
    expect(parse({ ...oauth, OAUTH_SCOPES: 'mcp, files:read  files:read' }).auth).toMatchObject({
      scopes: ['mcp', 'files:read'],
    });
    expect(problems({ ...oauth, OAUTH_SCOPES: 'mcp "quoted"' })).toEqual([
      'OAUTH_SCOPES has an invalid scope: ""quoted""',
    ]);
  });

  test('requires https endpoints in production', () => {
    expect(
      problems({ ...production, ...oauth, OAUTH_JWKS_URL: 'http://auth.example.com/jwks.json' }),
    ).toEqual(['OAUTH_JWKS_URL must use https in production']);
  });
});

test('names the variable and the accepted values for invalid enums', () => {
  expect(problems({ AUTH_MODE: 'basic' })[0]).toStartWith('AUTH_MODE:');
  expect(problems({ PORT: 'eighty' })[0]).toStartWith('PORT:');
});

describe('bearer', () => {
  test('needs a token without whitespace', () => {
    expect(problems({ AUTH_MODE: 'bearer' })).toEqual(['AUTH_MODE=bearer requires BEARER_TOKEN']);
    expect(problems({ AUTH_MODE: 'bearer', BEARER_TOKEN: 'two words' })).toEqual([
      'BEARER_TOKEN must not contain whitespace',
    ]);
    expect(parse({ AUTH_MODE: 'bearer', BEARER_TOKEN: 'secret' }).auth).toEqual({
      mode: 'bearer',
      token: 'secret',
    });
  });

  test('ignores the newline a pasted or piped secret often ends with', () => {
    expect(parse({ AUTH_MODE: 'bearer', BEARER_TOKEN: ' secret\n' }).auth).toEqual({
      mode: 'bearer',
      token: 'secret',
    });
    expect(problems({ AUTH_MODE: 'bearer', BEARER_TOKEN: '\n' })).toEqual([
      'AUTH_MODE=bearer requires BEARER_TOKEN',
    ]);
  });
});

describe('settings', () => {
  // Stub schemas stand in for src/settings.ts, so these tests don't depend on the sample's.
  const Flags = z.object({ FEATURE: z.enum(['on', 'off']).default('off') });
  const settingsOf = (env: Record<string, unknown>): unknown => parse(env, Flags).settings;

  test('are validated and exposed as config.settings', () => {
    expect(settingsOf({ FEATURE: 'on' })).toEqual({ FEATURE: 'on' });
    expect(settingsOf({})).toEqual({ FEATURE: 'off' });
  });

  test('a missing required setting is reported with every other problem', () => {
    const required = z.object({ PAYMENTS_API_KEY: z.string() });
    const reported = problems({ NODE_ENV: 'production' }, required);

    expect(reported.some((problem) => problem.startsWith('PAYMENTS_API_KEY:'))).toBe(true);
    expect(reported).toContain('MCP_PUBLIC_URL is required in production');
  });

  test('a cross-field rule is reported too', () => {
    const paired = z
      .object({ CLIENT_ID: z.string().optional(), CLIENT_SECRET: z.string().optional() })
      .refine((value) => !value.CLIENT_ID === !value.CLIENT_SECRET, {
        message: 'CLIENT_ID and CLIENT_SECRET must be set together',
      });
    expect(problems({ CLIENT_ID: 'id' }, paired)).toEqual([
      'CLIENT_ID and CLIENT_SECRET must be set together',
    ]);
  });

  test('an invalid value is named', () => {
    expect(problems({ FEATURE: 'maybe' }, Flags)[0]).toStartWith('FEATURE:');
  });
});
