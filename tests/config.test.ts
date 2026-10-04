import { describe, expect, test } from 'bun:test';
import { DEFAULT_MAX_REQUEST_BODY_SIZE } from '@modelcontextprotocol/server';
import { ConfigError, parseConfig } from '../src/platform/config';

/** The problems `parseConfig` reports for `env`, or `[]` when it is valid. */
function problems(env: Record<string, unknown>): string[] {
  try {
    parseConfig(env);
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
    const config = parseConfig({});

    expect(config.environment).toBe('development');
    expect(config.publicUrl.href).toBe('http://127.0.0.1:3000/mcp');
    expect(config.allowedHosts).toEqual(['127.0.0.1', 'localhost', '[::1]']);
    expect(config.allowedOrigins).toEqual(config.allowedHosts);
    expect(config.legacy).toBe('stateless');
    expect(config.maxRequestBytes).toBe(DEFAULT_MAX_REQUEST_BODY_SIZE);
    expect(config.auth).toEqual({ mode: 'none' });
  });

  test('production allows only the public hostname by default', () => {
    expect(parseConfig(production).allowedHosts).toEqual(['mcp.example.com']);
  });

  test('empty values count as unset, and non-string Worker bindings are ignored', () => {
    const config = parseConfig({ PORT: '', LOG_LEVEL: '', KV: { get() {} } });
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe('info');
  });
});

describe('production', () => {
  test('requires an explicit public URL and auth decision, reported together', () => {
    expect(problems({ NODE_ENV: 'production' })).toEqual([
      'MCP_PUBLIC_URL is required in production',
      'AUTH_MODE is required in production: "oauth", or "none" to serve without authentication',
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
      expect(problems({ MCP_ALLOWED_HOSTS: entry })).toEqual([
        `MCP_ALLOWED_HOSTS entries are lowercase hostnames without scheme or port, got "${entry}"`,
      ]);
    }
    expect(
      parseConfig({ MCP_ALLOWED_HOSTS: ' a.example.com, [::1] ,a.example.com' }).allowedHosts,
    ).toEqual(['a.example.com', '[::1]']);
  });

  test('origins may also admit every extension of a browser', () => {
    expect(
      parseConfig({ MCP_ALLOWED_ORIGIN_HOSTNAMES: 'moz-extension://*' }).allowedOrigins,
    ).toEqual(['moz-extension://*']);
    expect(problems({ MCP_ALLOWED_ORIGIN_HOSTNAMES: 'https://*' })).toHaveLength(1);
    expect(problems({ MCP_ALLOWED_HOSTS: 'moz-extension://*' })).toHaveLength(1);
  });
});

describe('oauth', () => {
  test('needs the authorization server endpoints and key set', () => {
    expect(problems({ AUTH_MODE: 'oauth' })).toEqual([
      'AUTH_MODE=oauth requires OAUTH_ISSUER_URL, OAUTH_AUTHORIZATION_URL, OAUTH_TOKEN_URL, OAUTH_JWKS_URL',
    ]);
  });

  test('keeps the issuer exactly as written', () => {
    const config = parseConfig({ ...oauth, OAUTH_ISSUER_URL: 'https://auth.example.com/tenant/' });
    expect(config.auth).toMatchObject({
      mode: 'oauth',
      issuer: 'https://auth.example.com/tenant/',
    });
  });

  test('parses scopes, separated by spaces or commas, and checks their syntax', () => {
    expect(
      parseConfig({ ...oauth, OAUTH_SCOPES: 'mcp, files:read  files:read' }).auth,
    ).toMatchObject({
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

describe('settings', () => {
  test('project settings from src/settings.ts are validated and exposed', () => {
    expect(parseConfig({}).settings).toEqual({});
    expect(parseConfig({ OPEN_METEO_API_KEY: 'key' }).settings).toEqual({
      OPEN_METEO_API_KEY: 'key',
    });
  });

  test('their problems are reported with the platform ones', () => {
    const reported = problems({ NODE_ENV: 'production', OPEN_METEO_API_KEY: 42 });
    expect(reported.some((problem) => problem.startsWith('OPEN_METEO_API_KEY:'))).toBe(true);
    expect(reported).toContain('MCP_PUBLIC_URL is required in production');
  });
});
