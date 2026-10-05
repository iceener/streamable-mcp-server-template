import {
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  localhostAllowedHostnames,
} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { Settings } from '../settings';

export type Environment = 'development' | 'production' | 'test';
export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

/**
 * Deployment configuration: what changes between local, staging and production.
 * Server identity (name, version, instructions) is code, in `src/server.ts`; settings your
 * own code needs (API keys, flags) are declared in `src/settings.ts`.
 */
export interface Config {
  environment: Environment;
  logLevel: LogLevel;
  /** Bun only: the interface and port `Bun.serve` binds. Workers ignore both. */
  host: string;
  port: number;
  /** Canonical public URL of the MCP endpoint. It is also the OAuth resource identifier. */
  publicUrl: URL;
  /** Hostnames accepted in the `Host` header (DNS-rebinding protection). */
  allowedHosts: string[];
  /** Hostnames, or `<scheme>://*` browser-extension entries, accepted in the `Origin` header. */
  allowedOrigins: string[];
  /** Serve 2025-era clients through the SDK's stateless fallback, or reject them. */
  legacy: 'stateless' | 'reject';
  /** Largest request body the SDK will read, in bytes. */
  maxRequestBytes: number;
  auth: AuthConfig;
  /** Your own settings, declared in `src/settings.ts`. */
  settings: Settings;
}

export type AuthConfig = { mode: 'none' } | BearerConfig | OAuthConfig;

/** Clients send one shared secret as `Authorization: Bearer <token>`. No OAuth discovery. */
export interface BearerConfig {
  mode: 'bearer';
  token: string;
}

/** This server is an OAuth resource server: an external authorization server issues tokens. */
export interface OAuthConfig {
  mode: 'oauth';
  /** The exact `iss` value in tokens. Compared byte for byte, never normalized. */
  issuer: string;
  authorizationUrl: URL;
  tokenUrl: URL;
  registrationUrl: URL | undefined;
  /** Where the authorization server publishes its keys. The JWT verifier needs it. */
  jwksUrl: URL | undefined;
  /** Scopes every request must carry. Tools that need more declare a `scopeChallenge`. */
  scopes: string[];
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

const LOOPBACK_HOSTNAMES = localhostAllowedHostnames();
/** Stands in for a missing or invalid URL while the remaining settings are checked. */
const UNSET_URL = 'https://unset.invalid/';
const HOSTNAME = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/;
const EXTENSION_ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/\*$/;
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warning', 'error']).default('info'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
  MCP_PUBLIC_URL: z.string().optional(),
  MCP_ALLOWED_HOSTS: z.string().optional(),
  MCP_ALLOWED_ORIGIN_HOSTNAMES: z.string().optional(),
  MCP_LEGACY_MODE: z.enum(['stateless', 'reject']).default('stateless'),
  MCP_MAX_REQUEST_BYTES: z.coerce.number().int().positive().default(DEFAULT_MAX_REQUEST_BODY_SIZE),
  AUTH_MODE: z.enum(['none', 'bearer', 'oauth']).optional(),
  BEARER_TOKEN: z.string().optional(),
  OAUTH_ISSUER_URL: z.string().optional(),
  OAUTH_AUTHORIZATION_URL: z.string().optional(),
  OAUTH_TOKEN_URL: z.string().optional(),
  OAUTH_REGISTRATION_URL: z.string().optional(),
  OAUTH_JWKS_URL: z.string().optional(),
  OAUTH_SCOPES: z.string().optional(),
});

type Env = z.infer<typeof EnvSchema>;

/**
 * Parse `process.env` (Bun) or the Worker `env`. Text values are trimmed, because a secret
 * stored with a trailing newline must not reach a provider with it; a blank value counts as
 * unset. Every problem is reported at once, so a misconfigured deploy fails with one clear
 * message.
 */
export function parseConfig(
  source: Readonly<Record<string, unknown>>,
  settingsSchema: z.ZodType<Settings> = Settings,
): Config {
  const present = Object.fromEntries(
    Object.entries(source)
      .map(([name, value]) => [name, typeof value === 'string' ? value.trim() : value] as const)
      .filter(([, value]) => value !== undefined && value !== ''),
  );
  const problems: string[] = [];
  const env = parseLeniently(EnvSchema, present, problems);
  const settings = parseLeniently(settingsSchema, present, problems);
  const config = buildConfig(env, settings, problems);
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/**
 * Report every invalid variable, then parse again without them, so the checks that follow
 * still run on defaults and can report their own problems in the same pass.
 */
function parseLeniently<Output>(
  schema: z.ZodType<Output>,
  values: Record<string, unknown>,
  problems: string[],
): Output {
  const result = schema.safeParse(values);
  if (result.success) return result.data;

  for (const issue of result.error.issues) {
    problems.push(
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    );
  }
  const invalid = new Set(result.error.issues.map((issue) => String(issue.path[0])));
  const retry = schema.safeParse(
    Object.fromEntries(Object.entries(values).filter(([name]) => !invalid.has(name))),
  );
  // The platform schema always parses once invalid values are gone, since every field has a
  // default or is optional. Yours may not (a required key is missing); its value is then never
  // used, because problems were found and parseConfig throws.
  return retry.success ? retry.data : ({} as Output);
}

function buildConfig(env: Env, settings: Settings, problems: string[]): Config {
  const production = env.NODE_ENV === 'production';
  const publicUrl = resolvePublicUrl(env, problems);
  const defaultHostnames = unique([publicUrl.hostname, ...(production ? [] : LOOPBACK_HOSTNAMES)]);

  if (production && !env.AUTH_MODE) {
    problems.push(
      'AUTH_MODE is required in production: "oauth", "bearer", or "none" to serve without authentication',
    );
  }

  const allowedHosts =
    parseHostnames('MCP_ALLOWED_HOSTS', env.MCP_ALLOWED_HOSTS, problems, {
      extensionOrigins: false,
    }) ?? defaultHostnames;
  if (publicUrl.href !== UNSET_URL && !allowedHosts.includes(publicUrl.hostname)) {
    problems.push(
      `MCP_ALLOWED_HOSTS must include the public URL's hostname, "${publicUrl.hostname}"`,
    );
  }

  return {
    environment: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    host: env.HOST,
    port: env.PORT,
    publicUrl,
    allowedHosts,
    allowedOrigins:
      parseHostnames('MCP_ALLOWED_ORIGIN_HOSTNAMES', env.MCP_ALLOWED_ORIGIN_HOSTNAMES, problems, {
        extensionOrigins: true,
      }) ?? defaultHostnames,
    legacy: env.MCP_LEGACY_MODE,
    maxRequestBytes: env.MCP_MAX_REQUEST_BYTES,
    auth: parseAuth(env, problems),
    settings,
  };
}

function parseAuth(env: Env, problems: string[]): AuthConfig {
  switch (env.AUTH_MODE) {
    case 'oauth':
      return parseOAuth(env, problems);
    case 'bearer': {
      // Secrets pasted or piped in often end with a newline; it is never part of the token.
      const token = env.BEARER_TOKEN ?? '';
      if (!token) problems.push('AUTH_MODE=bearer requires BEARER_TOKEN');
      else if (/\s/.test(token)) problems.push('BEARER_TOKEN must not contain whitespace');
      return { mode: 'bearer', token };
    }
    default:
      return { mode: 'none' };
  }
}

function parseOAuth(env: Env, problems: string[]): OAuthConfig {
  const required = {
    OAUTH_ISSUER_URL: env.OAUTH_ISSUER_URL,
    OAUTH_AUTHORIZATION_URL: env.OAUTH_AUTHORIZATION_URL,
    OAUTH_TOKEN_URL: env.OAUTH_TOKEN_URL,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);
  if (missing.length > 0) problems.push(`AUTH_MODE=oauth requires ${missing.join(', ')}`);

  // Missing values are reported above; parse a placeholder so each problem appears once.
  const url = (name: string, value: string | undefined) =>
    parseUrl(name, value ?? UNSET_URL, env.NODE_ENV, problems);

  const issuer = env.OAUTH_ISSUER_URL ?? UNSET_URL;
  if (url('OAUTH_ISSUER_URL', issuer).search) {
    problems.push('OAUTH_ISSUER_URL must not contain a query string');
  }

  const scopes = unique((env.OAUTH_SCOPES ?? '').split(/[\s,]+/).filter(Boolean));
  for (const scope of scopes) {
    if (!SCOPE_TOKEN.test(scope)) problems.push(`OAUTH_SCOPES has an invalid scope: "${scope}"`);
  }

  return {
    mode: 'oauth',
    issuer,
    authorizationUrl: url('OAUTH_AUTHORIZATION_URL', env.OAUTH_AUTHORIZATION_URL),
    tokenUrl: url('OAUTH_TOKEN_URL', env.OAUTH_TOKEN_URL),
    registrationUrl: env.OAUTH_REGISTRATION_URL
      ? url('OAUTH_REGISTRATION_URL', env.OAUTH_REGISTRATION_URL)
      : undefined,
    jwksUrl: env.OAUTH_JWKS_URL ? url('OAUTH_JWKS_URL', env.OAUTH_JWKS_URL) : undefined,
    scopes,
  };
}

/**
 * The public URL is the OAuth resource identifier, compared as a string by clients and
 * authorization servers. Requiring its canonical spelling keeps every comparison exact.
 */
function resolvePublicUrl(env: Env, problems: string[]): URL {
  const value = env.MCP_PUBLIC_URL;
  if (value === undefined) {
    if (env.NODE_ENV !== 'production') return new URL(`http://127.0.0.1:${env.PORT}/mcp`);
    problems.push('MCP_PUBLIC_URL is required in production');
    return new URL(UNSET_URL);
  }

  const url = parseUrl('MCP_PUBLIC_URL', value, env.NODE_ENV, problems);
  if (url.search) problems.push('MCP_PUBLIC_URL must not contain a query string');
  if (URL.canParse(value) && url.href !== value) {
    problems.push(`MCP_PUBLIC_URL must be written in canonical form: "${url.href}"`);
  }
  return url;
}

function parseUrl(name: string, value: string, environment: Environment, problems: string[]): URL {
  if (/\s/.test(value) || !URL.canParse(value)) {
    problems.push(`${name} must be an absolute URL, got "${value}"`);
    return new URL(UNSET_URL);
  }

  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    problems.push(`${name} must use http or https`);
  }
  if (url.username || url.password) problems.push(`${name} must not contain credentials`);
  if (value.includes('#')) problems.push(`${name} must not contain a fragment`);
  if (url.protocol === 'http:') {
    if (environment === 'production') {
      problems.push(`${name} must use https in production`);
    } else if (!LOOPBACK_HOSTNAMES.includes(url.hostname)) {
      problems.push(`${name} may use http only for localhost, 127.0.0.1 or [::1]`);
    }
  }
  return url;
}

/** Entries are matched as hostnames, port-agnostic, exactly as the SDK guards compare them. */
function parseHostnames(
  name: string,
  value: string | undefined,
  problems: string[],
  options: { extensionOrigins: boolean },
): string[] | undefined {
  if (value === undefined) return undefined;

  const entries = unique(
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  if (entries.length === 0) problems.push(`${name} must list at least one hostname`);

  for (const entry of entries) {
    if (HOSTNAME.test(entry)) continue;
    if (options.extensionOrigins && EXTENSION_ORIGIN.test(entry) && !entry.startsWith('http')) {
      continue;
    }
    problems.push(`${name} entries are lowercase hostnames without scheme or port, got "${entry}"`);
  }
  return entries;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
