import { describe, expect, test } from 'bun:test';
import { parseConfig } from '../src/config/env.js';

const oauth = {
  NODE_ENV: 'production',
  MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
  AUTH_ENABLED: 'true',
  OAUTH_ISSUER_URL: 'https://auth.example.com',
  OAUTH_AUTHORIZATION_URL: 'https://auth.example.com/authorize',
  OAUTH_TOKEN_URL: 'https://auth.example.com/token',
  OAUTH_JWKS_URL: 'https://auth.example.com/jwks',
};
const urlKeys = [
  'MCP_PUBLIC_URL',
  'MCP_WEBSITE_URL',
  'OAUTH_ISSUER_URL',
  'OAUTH_AUTHORIZATION_URL',
  'OAUTH_TOKEN_URL',
  'OAUTH_REGISTRATION_URL',
  'OAUTH_JWKS_URL',
];

describe('URL and exact resource configuration', () => {
  test('only permits HTTP(S), without userinfo or fragments, even when auth is disabled', () => {
    for (const key of urlKeys) {
      for (const value of [
        'ftp://localhost/mcp',
        'file://localhost/mcp',
        'ws://127.0.0.1/mcp',
        'https://user:password@example.com/mcp',
        'https://@example.com/mcp',
        'https:/@example.com/mcp',
        'https:////@example.com/mcp',
        'https://example.com/mcp\u00a0',
        'https://example.com/mcp#fragment',
        'https://example.com/mcp#',
      ]) {
        expect(() => parseConfig({ [key]: value })).toThrow();
      }
    }
  });

  test('HTTPS in production; HTTP only on deliberate local development/test endpoints', () => {
    for (const key of urlKeys) {
      for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
        const local = `http://${hostname}:8765/mcp`;
        expect(() => parseConfig({ ...oauth, [key]: local })).toThrow(
          `${key} must use HTTPS in production`,
        );
        expect(() => parseConfig({ NODE_ENV: 'test', [key]: local })).not.toThrow();
      }
      expect(() => parseConfig({ [key]: 'http://remote.example/mcp' })).toThrow(
        'HTTP only for loopback',
      );
    }
  });

  test('rejects public query strings and issuer queries, including empty delimiters', () => {
    for (const query of ['?', '?tenant=one']) {
      expect(() =>
        parseConfig({ MCP_PUBLIC_URL: `https://mcp.example/mcp${query}` }),
      ).toThrow('query');
      expect(() =>
        parseConfig({ OAUTH_ISSUER_URL: `https://auth.example${query}` }),
      ).toThrow('query');
    }
  });

  test('requires a canonical public endpoint and byte-exact audience equality', () => {
    for (const audience of [
      'https://MCP.example.com/mcp',
      'https://mcp.example.com:443/mcp',
      'https://mcp.example.com/m%63p',
      'https://mcp.example.com/MCP',
      'https://mcp.example.com/a/../mcp',
      'https://mcp.example.com/mcp/',
      'https://mcp.example.com/mcp#',
      'https://mcp.example.com/mcp?x=1',
    ]) {
      expect(() => parseConfig({ ...oauth, OAUTH_AUDIENCE: audience })).toThrow(
        'exactly match',
      );
    }
    for (const value of [
      'https://MCP.example.com/mcp',
      'https://mcp.example.com:443/mcp',
      'https://mcp.example.com/a/../mcp',
    ]) {
      expect(() =>
        parseConfig({ ...oauth, MCP_PUBLIC_URL: value, OAUTH_AUDIENCE: value }),
      ).toThrow('canonical');
    }
    for (const key of ['MCP_PUBLIC_URL', 'OAUTH_AUDIENCE', 'OAUTH_ISSUER_URL']) {
      expect(() =>
        parseConfig({ ...oauth, [key]: ' https://mcp.example.com/mcp' }),
      ).toThrow('whitespace');
    }
    const config = parseConfig(oauth);
    expect(config.OAUTH_AUDIENCE).toBe(oauth.MCP_PUBLIC_URL);
    expect(config.OAUTH_ISSUER_URL).toBe(oauth.OAUTH_ISSUER_URL);
    // Escaped paths can be canonical too; preserve their exact spelling.
    const escaped = 'https://mcp.example.com/m%63p';
    expect(parseConfig({ ...oauth, MCP_PUBLIC_URL: escaped }).OAUTH_AUDIENCE).toBe(
      escaped,
    );
  });
});
