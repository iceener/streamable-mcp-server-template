import { exportJWK, generateKeyPair, SignJWT } from 'jose';

/**
 * A stand-in authorization server for trying OAuth mode locally. It serves a JWKS, prints
 * the settings that point the MCP server at it, and mints an access token to paste into
 * MCP Inspector or any client that accepts a bearer token. Development only: it signs any
 * token you ask for.
 *
 *   bun run token                       # scopes "mcp actions:write", 1 hour
 *   bun run token --scope mcp           # without actions:write, to see the step-up 403
 *   bun run token --audience https://mcp.example.com/mcp
 */
const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]?.replace(/^--/, '');
  const value = process.argv[index + 1];
  if (name && value) args.set(name, value);
}

const port = Number(args.get('port') ?? 3001);
const audience = args.get('audience') ?? 'http://127.0.0.1:3000/mcp';
const scope = args.get('scope') ?? 'mcp actions:write';
const issuer = `http://127.0.0.1:${port}`;

const { privateKey, publicKey } = await generateKeyPair('ES256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'dev', alg: 'ES256', use: 'sig' };

Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch: (request) =>
    new URL(request.url).pathname === '/jwks.json'
      ? Response.json({ keys: [jwk] })
      : new Response('Not found', { status: 404 }),
});

const token = await new SignJWT({ client_id: 'dev-client', scope })
  .setProtectedHeader({ alg: 'ES256', kid: 'dev', typ: 'at+jwt' })
  .setIssuer(issuer)
  .setAudience(audience)
  .setSubject('dev-user')
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(privateKey);

console.info(`Local authorization server on ${issuer}. Keep this running.

1. Start the MCP server with:

AUTH_MODE=oauth \\
OAUTH_ISSUER_URL=${issuer} \\
OAUTH_AUTHORIZATION_URL=${issuer}/authorize \\
OAUTH_TOKEN_URL=${issuer}/token \\
OAUTH_JWKS_URL=${issuer}/jwks.json \\
OAUTH_SCOPES=mcp \\
bun run dev

2. Connect with this header (valid for 1 hour, scopes "${scope}"):

Authorization: Bearer ${token}
`);
