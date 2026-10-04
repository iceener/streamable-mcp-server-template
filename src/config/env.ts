export type RuntimeEnvironment = 'development' | 'production' | 'test';
export type LegacyMode = 'stateless' | 'reject';
export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

export interface AppConfig {
  HOST: string;
  PORT: number;
  NODE_ENV: RuntimeEnvironment;
  LOG_LEVEL: LogLevel;

  MCP_NAME: string;
  MCP_TITLE: string;
  MCP_VERSION: string;
  MCP_DESCRIPTION: string;
  MCP_INSTRUCTIONS: string;
  MCP_PUBLIC_URL: URL;
  MCP_WEBSITE_URL?: URL;
  MCP_ALLOWED_HOSTS: string[];
  MCP_ALLOWED_ORIGIN_HOSTNAMES: string[];
  MCP_LEGACY_MODE: LegacyMode;
  MCP_MAX_REQUEST_BYTES: number;

  AUTH_ENABLED: boolean;
  OAUTH_ISSUER_URL?: string;
  OAUTH_AUTHORIZATION_URL?: URL;
  OAUTH_TOKEN_URL?: URL;
  OAUTH_REGISTRATION_URL?: URL;
  OAUTH_JWKS_URL?: URL;
  OAUTH_AUDIENCE?: string;
  OAUTH_REQUIRED_SCOPES: string[];
  OAUTH_JWT_ALGORITHMS: string[];
  OAUTH_CLIENT_ID_CLAIM: string;
  OAUTH_RESPONSE_TYPES_SUPPORTED: string[];
  OAUTH_GRANT_TYPES_SUPPORTED: string[];
  OAUTH_CODE_CHALLENGE_METHODS_SUPPORTED: string[];
}

function stringValue(env: Record<string, unknown>, key: string, fallback = ''): string {
  const value = env[key];
  return value === undefined || value === null || value === ''
    ? fallback
    : String(value).trim();
}

function booleanValue(env: Record<string, unknown>, key: string): boolean {
  const value = stringValue(env, key).toLowerCase();
  if (!value || ['0', 'false', 'no', 'off'].includes(value)) return false;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  throw new Error(`${key} must be true or false`);
}

function numberValue(
  env: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = Number(stringValue(env, key, String(fallback)));
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${key} must be an integer between 1 and 65535`);
  }
  return value;
}

function requestSizeValue(env: Record<string, unknown>): number {
  const value = Number(stringValue(env, 'MCP_MAX_REQUEST_BYTES', '1048576'));
  if (!Number.isInteger(value) || value < 1_024 || value > 10_485_760) {
    throw new Error(
      'MCP_MAX_REQUEST_BYTES must be an integer between 1024 and 10485760',
    );
  }
  return value;
}

function listValue(
  env: Record<string, unknown>,
  key: string,
  fallback: string[] = [],
): string[] {
  const value = stringValue(env, key);
  if (!value) return [...fallback];
  return [
    ...new Set(
      value
        .split(/[ ,]+/)
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ];
}

function enumValue<T extends string>(
  env: Record<string, unknown>,
  key: string,
  values: readonly T[],
  fallback: T,
): T {
  const value = stringValue(env, key, fallback) as T;
  if (!values.includes(value)) {
    throw new Error(`${key} must be one of: ${values.join(', ')}`);
  }
  return value;
}

// Do not silently trim or normalize OAuth identifiers before comparing them.
function urlInput(env: Record<string, unknown>, key: string, fallback = ''): string {
  const value = env[key];
  const raw =
    value === undefined || value === null || value === '' ? fallback : String(value);
  if (
    /\s/u.test(raw) ||
    [...raw].some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  ) {
    throw new Error(`${key} must not contain whitespace or control characters`);
  }
  return raw;
}

function urlValue(
  env: Record<string, unknown>,
  key: string,
  fallback?: string,
): URL | undefined {
  const value = urlInput(env, key, fallback);
  if (!value) return undefined;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be an absolute URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${key} must use HTTP or HTTPS`);
  }
  const authority = value.split('/')[2];
  if (!/^https?:\/\//i.test(value) || !authority || value.includes('\\')) {
    throw new Error(`${key} must be an absolute HTTP(S) URL with an authority`);
  }
  if (url.username || url.password || authority.includes('@')) {
    throw new Error(`${key} must not include userinfo`);
  }
  if (value.includes('#')) {
    throw new Error(`${key} must not include a fragment`);
  }
  return url;
}

function requireValue<T>(value: T | undefined, key: string): T {
  if (value === undefined) {
    throw new Error(`${key} is required when AUTH_ENABLED=true`);
  }
  return value;
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function validateSecureUrl(
  url: URL,
  key: string,
  environment: RuntimeEnvironment,
): void {
  if (url.protocol === 'https:') return;
  if (environment === 'production') {
    throw new Error(`${key} must use HTTPS in production`);
  }
  if (!isLoopback(url.hostname)) {
    throw new Error(`${key} may use HTTP only for loopback development or tests`);
  }
}

function validatePublicUrl(url: URL, environment: RuntimeEnvironment): void {
  if (url.href.includes('?') || url.href.includes('#')) {
    throw new Error('MCP_PUBLIC_URL must not include a query string or fragment');
  }
  validateSecureUrl(url, 'MCP_PUBLIC_URL', environment);
}

/** Parse deployment-scoped configuration for Bun or Cloudflare Workers. */
export function parseConfig(env: Record<string, unknown>): AppConfig {
  const port = numberValue(env, 'PORT', 3000);
  const environment = enumValue(
    env,
    'NODE_ENV',
    ['development', 'production', 'test'] as const,
    'development',
  );
  const configuredPublicUrl = urlInput(env, 'MCP_PUBLIC_URL');
  if (environment === 'production' && !configuredPublicUrl) {
    throw new Error('MCP_PUBLIC_URL is required in production');
  }
  const publicUrl = urlValue(
    env,
    'MCP_PUBLIC_URL',
    `http://localhost:${port}/mcp`,
  ) as URL;
  validatePublicUrl(publicUrl, environment);
  // Stable SDK metadata and AuthInfo accept URL objects. Require a canonical
  // spelling up front so serialization cannot change the resource identifier.
  if (configuredPublicUrl && configuredPublicUrl !== publicUrl.href) {
    throw new Error('MCP_PUBLIC_URL must use its canonical URL spelling');
  }

  const defaultHosts = [publicUrl.hostname];
  if (environment !== 'production') {
    defaultHosts.push('localhost', '127.0.0.1', '[::1]');
  }

  const authEnabled = booleanValue(env, 'AUTH_ENABLED');
  const issuer = urlInput(env, 'OAUTH_ISSUER_URL') || undefined;
  const issuerUrl = urlValue(env, 'OAUTH_ISSUER_URL');
  const authorizationUrl = urlValue(env, 'OAUTH_AUTHORIZATION_URL');
  const tokenUrl = urlValue(env, 'OAUTH_TOKEN_URL');
  const jwksUrl = urlValue(env, 'OAUTH_JWKS_URL');
  const registrationUrl = urlValue(env, 'OAUTH_REGISTRATION_URL');
  const websiteUrl = urlValue(env, 'MCP_WEBSITE_URL');
  const audience = urlInput(
    env,
    'OAUTH_AUDIENCE',
    configuredPublicUrl || publicUrl.href,
  );

  if (issuerUrl?.href.includes('?')) {
    throw new Error('OAUTH_ISSUER_URL must not include a query string');
  }
  const configuredUrls: Array<[string, URL | undefined]> = [
    ['OAUTH_ISSUER_URL', issuerUrl],
    ['OAUTH_AUTHORIZATION_URL', authorizationUrl],
    ['OAUTH_TOKEN_URL', tokenUrl],
    ['OAUTH_JWKS_URL', jwksUrl],
    ['OAUTH_REGISTRATION_URL', registrationUrl],
    ['MCP_WEBSITE_URL', websiteUrl],
  ];
  for (const [key, url] of configuredUrls) {
    if (url) validateSecureUrl(url, key, environment);
  }

  if (authEnabled) {
    if (audience !== (configuredPublicUrl || publicUrl.href)) {
      throw new Error('OAUTH_AUDIENCE must exactly match MCP_PUBLIC_URL');
    }
    requireValue(issuer, 'OAUTH_ISSUER_URL');
    requireValue(authorizationUrl, 'OAUTH_AUTHORIZATION_URL');
    requireValue(tokenUrl, 'OAUTH_TOKEN_URL');
  }

  const allowedHosts = listValue(env, 'MCP_ALLOWED_HOSTS', defaultHosts);
  const allowedOriginHostnames = listValue(
    env,
    'MCP_ALLOWED_ORIGIN_HOSTNAMES',
    defaultHosts,
  );

  if (allowedHosts.length === 0 || allowedOriginHostnames.length === 0) {
    throw new Error('MCP Host and Origin allowlists must not be empty');
  }

  return {
    HOST: stringValue(env, 'HOST', '127.0.0.1'),
    PORT: port,
    NODE_ENV: environment,
    LOG_LEVEL: enumValue(
      env,
      'LOG_LEVEL',
      ['debug', 'info', 'warning', 'error'] as const,
      'info',
    ),

    MCP_NAME: stringValue(env, 'MCP_NAME', 'mcp-server-template'),
    MCP_TITLE: stringValue(env, 'MCP_TITLE', 'MCP Server Template'),
    MCP_VERSION: stringValue(env, 'MCP_VERSION', '1.0.0'),
    MCP_DESCRIPTION: stringValue(
      env,
      'MCP_DESCRIPTION',
      'A modern MCP server template for Bun and Cloudflare Workers.',
    ),
    MCP_INSTRUCTIONS: stringValue(
      env,
      'MCP_INSTRUCTIONS',
      'Use the available tools and resources. Keep tool inputs concise.',
    ),
    MCP_PUBLIC_URL: publicUrl,
    MCP_WEBSITE_URL: websiteUrl,
    MCP_ALLOWED_HOSTS: allowedHosts,
    MCP_ALLOWED_ORIGIN_HOSTNAMES: allowedOriginHostnames,
    MCP_LEGACY_MODE: enumValue(
      env,
      'MCP_LEGACY_MODE',
      ['stateless', 'reject'] as const,
      'stateless',
    ),
    MCP_MAX_REQUEST_BYTES: requestSizeValue(env),

    AUTH_ENABLED: authEnabled,
    OAUTH_ISSUER_URL: issuer,
    OAUTH_AUTHORIZATION_URL: authorizationUrl,
    OAUTH_TOKEN_URL: tokenUrl,
    OAUTH_REGISTRATION_URL: registrationUrl,
    OAUTH_JWKS_URL: jwksUrl,
    OAUTH_AUDIENCE: audience || undefined,
    OAUTH_REQUIRED_SCOPES: listValue(env, 'OAUTH_REQUIRED_SCOPES'),
    OAUTH_JWT_ALGORITHMS: listValue(env, 'OAUTH_JWT_ALGORITHMS', ['RS256', 'ES256']),
    OAUTH_CLIENT_ID_CLAIM: stringValue(env, 'OAUTH_CLIENT_ID_CLAIM', 'client_id'),
    OAUTH_RESPONSE_TYPES_SUPPORTED: listValue(env, 'OAUTH_RESPONSE_TYPES_SUPPORTED', [
      'code',
    ]),
    OAUTH_GRANT_TYPES_SUPPORTED: listValue(env, 'OAUTH_GRANT_TYPES_SUPPORTED', [
      'authorization_code',
    ]),
    OAUTH_CODE_CHALLENGE_METHODS_SUPPORTED: listValue(
      env,
      'OAUTH_CODE_CHALLENGE_METHODS_SUPPORTED',
      ['S256'],
    ),
  };
}
