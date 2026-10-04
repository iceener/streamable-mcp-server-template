# Authentication

With `AUTH_MODE=oauth` this server is an OAuth 2.1 **resource server**, as the [MCP authorization spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) describes. An external **authorization server** signs users in and issues tokens. This server checks them. It never issues tokens and never stores them.

## How a client gets in

1. The client calls `/mcp` without a token and gets `401` with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"`.
2. It reads that document ([RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728)), which names your authorization server and the scopes this server uses.
3. It signs the user in with that authorization server: authorization code flow with PKCE S256, asking for a token for this server's URL (`resource=https://…/mcp`, [RFC 8707](https://datatracker.ietf.org/doc/html/rfc8707)).
4. It calls `/mcp` again with `Authorization: Bearer <token>`.

The server serves both discovery documents for you: the protected-resource metadata, and a copy of your authorization server's metadata at `/.well-known/oauth-authorization-server` for clients that look there. Anyone can fetch both, from any origin.

## What a token must contain

The built-in verifier (`src/platform/jwt.ts`) checks JWT access tokens locally against the authorization server's published keys:

| Claim | Must be |
|---|---|
| signature | Valid for a key in `OAUTH_JWKS_URL`, with an asymmetric algorithm (RS, PS, ES or EdDSA) |
| `iss` | Exactly `OAUTH_ISSUER_URL` |
| `aud` | Contains exactly `MCP_PUBLIC_URL` |
| `exp`, `nbf` | Current, allowing 30 s of clock difference |
| `client_id` or `azp` | Present |
| `scope` | Includes every scope in `OAUTH_SCOPES` |

The audience check matters most. It stops a token issued for another server from working here, even when both servers trust the same authorization server. The SDK's `expectedResource` check repeats it, whatever verifier you use.

Failures answer `401 invalid_token`, or `403 insufficient_scope` naming the missing scopes. If the key set can't be fetched, the answer is `500` instead, so clients keep their token and retry rather than signing in again. Set `LOG_LEVEL=debug` to log why each token was rejected.

## Try it locally

```sh
bun run token                # terminal 1: local key server; prints settings and a token
```

```sh
AUTH_MODE=oauth OAUTH_ISSUER_URL=http://127.0.0.1:3001 … bun run dev   # terminal 2: paste the printed settings
```

Then connect with the printed `Authorization` header. In MCP Inspector, add it under **Authentication**; with Claude Code, use `claude mcp add --transport http weather http://127.0.0.1:3000/mcp --header "Authorization: Bearer …"`. Call `whoami` to see the caller the server verified. Run `bun run token --scope mcp` for a token without `actions:write`: `confirm-action` then answers `403 insufficient_scope`.

The local key server signs whatever you ask it to. Don't use it outside your machine.

## Use a real authorization server

Point the `OAUTH_*` variables at your provider (Auth0, Clerk, Cognito, Keycloak, Okta, Stytch, WorkOS and others):

```sh
AUTH_MODE=oauth
OAUTH_ISSUER_URL=https://auth.example.com
OAUTH_AUTHORIZATION_URL=https://auth.example.com/oauth2/authorize
OAUTH_TOKEN_URL=https://auth.example.com/oauth2/token
OAUTH_JWKS_URL=https://auth.example.com/.well-known/jwks.json
OAUTH_REGISTRATION_URL=https://auth.example.com/oauth2/register   # if it supports dynamic registration
OAUTH_SCOPES=mcp
```

Copy these values from the provider's `/.well-known/openid-configuration` or `/.well-known/oauth-authorization-server` document. Check that the provider:

- **issues JWT access tokens.** For opaque tokens, see [Verify tokens another way](#verify-tokens-another-way).
- **puts this server's URL in `aud`** when the client asks with `resource=`. Some providers call this an API identifier or audience. Set it to your `MCP_PUBLIC_URL`, exactly.
- **supports PKCE S256**, as MCP requires.
- **lets MCP clients register.** That can be dynamic client registration (`OAUTH_REGISTRATION_URL`), client ID metadata documents, or clients you register by hand.
- **allows the clients' redirect URIs.** Desktop clients use loopback addresses such as `http://127.0.0.1:<port>/callback`, with a different port each time. Hosted clients use their own HTTPS callback, for example `https://claude.ai/api/mcp/auth_callback`.

## Per-tool scopes

`OAUTH_SCOPES` applies to every request. A tool, resource or prompt that needs more declares it:

```ts
scopeChallenge: requireScopes('actions:write'),
```

The SDK answers `403 insufficient_scope` naming exactly the missing scopes before the handler runs, and the client can ask the user to grant them. A callback can decide per request; see the SDK's [authorization guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/authorization.md#enforce-per-operation-scopes).

## Reading the caller

Handlers get the verified caller as `ctx.http?.authInfo`: `clientId`, `scopes`, `expiresAt`, `resource`, and `extra.subject` (the `sub` claim). `whoami` shows it. The `token` field is always empty. The HTTP layer removes the raw token before any handler runs, because the MCP spec forbids passing a client's token to another API. To act on the user's behalf somewhere else, exchange it for a token issued for that API ([RFC 8693](https://datatracker.ietf.org/doc/html/rfc8693)), inside the verifier.

## Verify tokens another way

To use opaque tokens with [introspection (RFC 7662)](https://datatracker.ietf.org/doc/html/rfc7662), a static key for private deployments, or anything else, write an `OAuthTokenVerifier` and use it in `createAuth` (`src/platform/auth.ts`) in place of `createJwtVerifier`:

```ts
const verifier: OAuthTokenVerifier = {
  async verifyAccessToken(token) {
    const claims = await introspect(token); // your call to the authorization server
    if (!claims.active) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token is not active');
    return {
      token,
      clientId: claims.client_id,
      scopes: claims.scope.split(' '),
      expiresAt: claims.exp,
      resource: new URL(claims.aud),
    };
  },
};
```

Throw `OAuthError(OAuthErrorCode.InvalidToken, …)` for a bad token. Any other error becomes a `500`. Always set `expiresAt` and `resource`: the gate rejects tokens without them. If you no longer need `OAUTH_JWKS_URL`, remove it from the required list in `src/platform/config.ts`.
