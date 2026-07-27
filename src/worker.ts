import { preloadSchemas } from '@modelcontextprotocol/server';
import { parseConfig } from './config/env.js';
import { buildHttpApp, type HttpRuntime } from './http/app.js';

// Move schema construction into isolate startup instead of the first request.
preloadSchemas();

export function createWorkerRuntime(env: Env): HttpRuntime {
  const config = parseConfig({ ...env });
  return buildHttpApp(config, { runtimeName: 'cloudflare-workers' });
}

let runtime: HttpRuntime | undefined;

export default {
  fetch(request, env) {
    runtime ??= createWorkerRuntime(env);
    return runtime.fetch(request);
  },
} satisfies ExportedHandler<Env>;
