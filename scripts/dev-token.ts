import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importJWK,
  type JWK,
  SignJWT,
} from 'jose';

/**
 * A stand-in authorization server for trying OAuth locally. It serves a JWKS, prints the
 * settings that point the MCP server at it, and mints an access token for any client that
 * accepts a bearer token. Development only: it signs whatever you ask for.
 *
 *   bun run token                          scopes "mcp actions:write", valid for 1 hour
 *   bun run token --scope mcp              without actions:write, to see the 403 step-up
 *   bun run token --audience <url>         defaults to MCP_PUBLIC_URL, or 127.0.0.1:$PORT
 *   bun run token --port 3010              where the JWKS is served
 *
 * The signing key is kept in node_modules/.cache, so tokens stay valid across restarts.
 * Running it again while the first one serves the JWKS just mints another token.
 */
const options = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]?.replace(/^--/, '');
  const value = process.argv[index + 1];
  if (name && value) options.set(name, value);
}

const port = Number(options.get('port') ?? 3010);
const issuer = `http://127.0.0.1:${port}`;
const audience =
  options.get('audience') ??
  Bun.env.MCP_PUBLIC_URL ??
  `http://127.0.0.1:${Bun.env.PORT ?? 3000}/mcp`;
const scope = options.get('scope') ?? 'mcp actions:write';

const { privateKey, publicJwk } = await loadKey('node_modules/.cache/mcp-dev-token.json');

try {
  Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch: (request) =>
      new URL(request.url).pathname === '/jwks.json'
        ? Response.json({ keys: [publicJwk] })
        : new Response('Not found', { status: 404 }),
  });
  console.info(`Local authorization server on ${issuer}. Keep this running.\n`);
  console.info(`Start the MCP server with:

AUTH_MODE=oauth \\
OAUTH_ISSUER_URL=${issuer} \\
OAUTH_AUTHORIZATION_URL=${issuer}/authorize \\
OAUTH_TOKEN_URL=${issuer}/token \\
OAUTH_JWKS_URL=${issuer}/jwks.json \\
OAUTH_SCOPES=mcp \\
bun run dev
`);
} catch (error) {
  if (!(await servesThisKey())) {
    throw new Error(`Port ${port} is in use by something else. Pass --port <free port>.`, {
      cause: error,
    });
  }
  console.info(`Using the authorization server already running on ${issuer}.\n`);
}

const token = await new SignJWT({ client_id: 'dev-client', scope })
  .setProtectedHeader({ alg: 'ES256', kid: publicJwk.kid, typ: 'at+jwt' })
  .setIssuer(issuer)
  .setAudience(audience)
  .setSubject('dev-user')
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(privateKey);

console.info(`Token for ${audience}, scopes "${scope}", valid for 1 hour:

Authorization: Bearer ${token}
`);
if (!Bun.env.PORT && !options.has('audience')) {
  console.info('If your server is not on port 3000, pass --audience with its MCP URL.');
}

async function loadKey(path: string) {
  const file = Bun.file(path);
  let privateJwk: JWK;
  if (await file.exists()) {
    privateJwk = await file.json();
  } else {
    const pair = await generateKeyPair('ES256', { extractable: true });
    privateJwk = await exportJWK(pair.privateKey);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, JSON.stringify(privateJwk));
  }
  const { d: _private, ...publicPart } = privateJwk;
  const kid = await calculateJwkThumbprint(publicPart);
  return {
    privateKey: await importJWK(privateJwk, 'ES256'),
    publicJwk: { ...publicPart, kid, alg: 'ES256', use: 'sig' },
  };
}

async function servesThisKey(): Promise<boolean> {
  try {
    const response = await fetch(`${issuer}/jwks.json`, { signal: AbortSignal.timeout(2_000) });
    const { keys } = (await response.json()) as { keys?: Array<{ kid?: string }> };
    return keys?.some((key) => key.kid === publicJwk.kid) ?? false;
  } catch {
    return false;
  }
}
