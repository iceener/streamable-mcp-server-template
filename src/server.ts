/**
 * The project's half of the template. `platform/` relies on exactly these exports:
 * `serverInfo`, `SERVER_ICON_PATH`, `SERVER_ICON_SVG`, `Deps`, `createDeps`, `createServer`,
 * `createVerifier` and `routes`. Change what they contain, but keep their names and shapes.
 */
import {
  type CacheHint,
  McpServer,
  type McpServerFactory,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import type { Hono } from 'hono';
import { type Config, ConfigError, type OAuthConfig } from './platform/config';
import { createJwtVerifier } from './platform/jwt';
import type { Logger } from './platform/logger';
import { prompts } from './prompts';
import { resources } from './resources';
import { createWeatherService, type WeatherService } from './services/weather';
import { tools } from './tools';

/** Who this server is. Change every field when you start from the template. */
export const serverInfo = {
  name: 'mcp-server-template',
  title: 'MCP Server Template',
  version: '2.0.0',
  description: 'Weather forecasts, plus a reference set of MCP tools, resources and prompts.',
  websiteUrl: 'https://github.com/iceener/streamable-mcp-server-template',
};

/** Sent to clients on connect. Many hosts add it to the model's system prompt. */
const instructions =
  'Use get-forecast for weather questions. Read docs://server/guide for what each tool does.';

export const SERVER_ICON_PATH = '/icon.svg';
export const SERVER_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="MCP server">
  <rect width="64" height="64" rx="12" fill="#111827"/>
  <path d="M18 44V20h7l7 10 7-10h7v24h-7V31l-7 10-7-10v13z" fill="#fff"/>
</svg>`;

/** Everything tools, resources and prompts may use. Built once, shared by every request. */
export interface Deps {
  config: Config;
  logger: Logger;
  weather: WeatherService;
}

export function createDeps(config: Config, logger: Logger): Deps {
  return {
    config,
    logger,
    weather: createWeatherService({ apiKey: config.settings.OPEN_METEO_API_KEY }),
  };
}

/**
 * How bearer tokens are checked when `AUTH_MODE=oauth`: JWTs, against the authorization
 * server's published keys. Return your own `OAuthTokenVerifier` to use introspection or
 * another scheme; docs/auth.md shows one.
 */
export function createVerifier(oauth: OAuthConfig, deps: Deps): OAuthTokenVerifier {
  if (!oauth.jwksUrl) {
    throw new ConfigError(['OAUTH_JWKS_URL is required to verify JWT access tokens']);
  }
  return createJwtVerifier(
    { issuer: oauth.issuer, jwksUrl: oauth.jwksUrl, audience: deps.config.publicUrl.href },
    deps.logger,
  );
}

/**
 * Extra HTTP routes outside MCP: webhooks, OAuth callbacks, status pages. They sit behind the
 * same Host and Origin checks as the MCP endpoint, but not behind its bearer token check, and
 * they get no CORS headers: browsers on other origins can't read them unless you add those.
 */
export function routes(_app: Hono, _deps: Deps): void {
  // _app.post('/webhooks/provider', async (c) => { … });
}

/** Lists only change on deploy, and are the same for every caller. */
const LIST_CACHE: CacheHint = { ttlMs: 60_000, cacheScope: 'public' };

/**
 * The SDK calls this factory once per HTTP request and serves that request with the fresh
 * `McpServer` it returns. Keep it cheap and free of I/O: shared clients live in `deps`.
 */
export function createServer(deps: Deps): McpServerFactory {
  const icons = [
    {
      src: new URL(SERVER_ICON_PATH, deps.config.publicUrl).href,
      mimeType: 'image/svg+xml',
      sizes: ['any'],
    },
  ];

  return () => {
    const server = new McpServer(
      { ...serverInfo, icons },
      {
        instructions,
        // Lists change only on deploy, and each request has its own server instance, so there
        // is nothing to notify about. Advertising change streams would keep listeners open
        // for events that never come. docs/architecture.md explains how to add them.
        capabilities: {
          tools: { listChanged: false },
          prompts: { listChanged: false },
          resources: { listChanged: false, subscribe: false },
        },
        cacheHints: {
          'server/discover': LIST_CACHE,
          'tools/list': LIST_CACHE,
          'prompts/list': LIST_CACHE,
          'resources/list': LIST_CACHE,
          'resources/templates/list': LIST_CACHE,
        },
        // Reject tool arguments with more array elements and object members than this,
        // before schema validation runs. Raise it if a tool takes large inputs.
        maxToolInputElements: 1_000,
      },
    );

    for (const primitive of [...tools, ...resources, ...prompts]) {
      primitive.register(server, deps);
    }
    return server;
  };
}
