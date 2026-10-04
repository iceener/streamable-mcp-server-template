import { type App, createApp } from './platform/app';
import { parseConfig } from './platform/config';
import { createLogger } from './platform/logger';

/**
 * Workers receive `env` with each request, so the app is built on the first request and
 * reused for the isolate's lifetime. Bad configuration is logged once and answered with a
 * generic 500; the details stay in Workers Logs, not in responses.
 */
let app: App | undefined;
let misconfigured = false;

export default {
  async fetch(request, env) {
    if (!app && !misconfigured) {
      try {
        app = createApp(parseConfig({ ...env }));
      } catch (error) {
        misconfigured = true;
        createLogger('error').error('Invalid configuration; fix it and redeploy', { error });
      }
    }
    return app
      ? app.fetch(request)
      : Response.json({ error: 'server_misconfigured' }, { status: 500 });
  },
} satisfies ExportedHandler<Env>;
