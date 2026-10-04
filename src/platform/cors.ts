/**
 * CORS for browser-based MCP clients. The Origin itself is checked earlier by the SDK's
 * `originValidationResponse`, so these helpers only ever answer an allowed origin.
 */

/** Answer a preflight for the MCP endpoint: POST, with whatever headers the client sends. */
export function corsPreflight(request: Request): Response {
  const origin = request.headers.get('Origin');
  if (!origin) return new Response(null, { status: 204 });

  const method = request.headers.get('Access-Control-Request-Method');
  if (method && method.toUpperCase() !== 'POST') {
    return new Response('CORS method not allowed', { status: 405 });
  }

  const headers = new Headers({
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '600',
  });
  const requested = request.headers.get('Access-Control-Request-Headers');
  if (requested) headers.set('Access-Control-Allow-Headers', requested);
  addVary(headers, 'Origin', 'Access-Control-Request-Method', 'Access-Control-Request-Headers');
  return new Response(null, { status: 204, headers });
}

/** Let an allowed browser origin read the response, without buffering SSE bodies. */
export function withCors(request: Request, response: Response): Response {
  const origin = request.headers.get('Origin');
  if (!origin) return response;

  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Expose-Headers', 'WWW-Authenticate');
  addVary(headers, 'Origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function addVary(headers: Headers, ...values: string[]): void {
  const current = (headers.get('Vary') ?? '').split(',').map((value) => value.trim());
  headers.set('Vary', [...new Set([...current, ...values].filter(Boolean))].join(', '));
}
