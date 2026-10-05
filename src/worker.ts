import { type App, createApp } from './platform/app';
import { ConfigError, parseConfig } from './platform/config';
import { createLogger } from './platform/logger';

/**
 * Workers receive `env` with each request, so the app is built on the first request and
 * reused for the isolate's lifetime. If that fails (bad configuration, or a registration
 * mistake such as a duplicate tool name), it is logged once and every request gets a generic
 * 500 until the next deploy; the details stay in Workers Logs, not in responses.
 *
 * Bindings (KV, D1, Durable Objects) reach your code through `runtime`, typed in
 * `src/server.ts`. Export any Durable Object classes from this module, as Workers require.
 */
let app: App | undefined;
let misconfigured = false;

export default {
  async fetch(request, env) {
    if (!app && !misconfigured) {
      try {
        app = createApp(parseConfig({ ...env }), { runtime: {} });
      } catch (error) {
        misconfigured = true;
        const message =
          error instanceof ConfigError ? 'Invalid configuration' : 'The server failed to start';
        createLogger('error').error(`${message}; fix it and redeploy`, { error });
      }
    }
    return app
      ? app.fetch(request)
      : Response.json({ error: 'server_misconfigured' }, { status: 500 });
  },
} satisfies ExportedHandler<Env>;
