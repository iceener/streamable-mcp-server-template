# Authentication

With `AUTH_MODE=oauth` this server is an OAuth 2.1 **resource server**, as the [MCP authorization spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) describes. An external **authorization server** signs users in and issues tokens. This server checks them. It never issues tokens and never stores them.

## How a client gets in

1. The client calls `/mcp` without a token and gets `401` with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"`.
2. It reads that document ([RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728)). The document names your authorization server and the scopes every request needs (`OAUTH_SCOPES`).
3. It signs the user in with that authorization server: authorization code flow with PKCE S256, asking for a token for this server's URL (`resource=https://…/mcp`, [RFC 8707](https://datatracker.ietf.org/doc/html/rfc8707)).
4. It calls `/mcp` again with `Authorization: Bearer <token>`. If a tool needs more scopes, the client finds out from that tool's `403` and can ask for them.

The server publishes the protected-resource document, which is the one clients are meant to use. It also serves a copy of your authorization server's main endpoints at `/.well-known/oauth-authorization-server`, for older clients that look there. Anyone can fetch both, from any origin.

## What a token must contain

The built-in verifier (`src/platform/jwt.ts`) checks JWT access tokens locally against the authorization server's published keys:

| Claim | Must be |
|---|---|
| signature | Valid for a key in `OAUTH_JWKS_URL` (required for this verifier), with an asymmetric algorithm (RS, PS, ES or EdDSA) |
| `iss` | Exactly `OAUTH_ISSUER_URL` |
| `aud` | Contains exactly `MCP_PUBLIC_URL` |
| `exp`, `nbf` | Current, allowing 30 s of clock difference |
| `client_id` or `azp` | Present |
| `scope` | Includes every scope in `OAUTH_SCOPES` |

The audience check matters most. It stops a token issued for another server from working here, even when both servers trust the same authorization server. It happens twice: the verifier checks `aud`, and the SDK's `expectedResource` then checks the audience the verifier reports. The second check still holds if you replace the verifier.

Bad tokens get `401 invalid_token`. Tokens without the required scopes get `403 insufficient_scope`, naming the scopes required. If the key set can't be fetched or read (the server is unreachable, answers an error, or returns something that isn't a key set), the answer is `500` instead, so clients keep their token and retry rather than signing in again; the server logs this at `error`. Set `LOG_LEVEL=debug` to log why each token was rejected.

## Try it locally

`bun run token` is a stand-in authorization server. It serves a key set on port 3010, prints the settings that point the MCP server at it, and prints a token:

```sh
bun run token          # terminal 1: keep it running
```

Start the MCP server with the printed settings in a second terminal, then connect with the printed `Authorization` header. In MCP Inspector, add it under **Authentication**. With Claude Code, use `claude mcp add --transport http weather http://127.0.0.1:3000/mcp --header "Authorization: Bearer …"`. Call `whoami` to see the caller the server verified.

For a token with other scopes, run it again in a third terminal. It reuses the issuer that's already running:

```sh
bun run token --scope mcp    # without actions:write: confirm-action now answers 403
```

The token's audience follows `MCP_PUBLIC_URL`, or `PORT` from your environment. Pass `--audience <url>` if your server listens somewhere else, and `--port` to serve the key set on another port. The signing key is kept in `node_modules/.cache`, so tokens survive restarts of either process. This issuer signs whatever you ask it to: don't use it outside your machine.

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
- **allows the clients' redirect URIs.** Desktop clients use loopback addresses such as `http://127.0.0.1:<port>/callback`, with a different port each time. Hosted clients use their own HTTPS callback.

## Per-tool scopes

`OAUTH_SCOPES` applies to every request. A tool, resource or prompt that needs more declares it:

```ts
scopeChallenge: requireScopes('actions:write'),
```

The SDK answers `403 insufficient_scope` naming the scopes the tool requires, before the handler runs, and the client can ask the user to grant them. A callback can decide per request; see the SDK's [authorization guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/authorization.md#enforce-per-operation-scopes).

## Reading the caller

Handlers get the verified caller as `ctx.http?.authInfo`: `clientId`, `scopes`, `expiresAt`, `resource`, and `extra.subject` (the `sub` claim). `whoami` shows it. Handlers never get the credential itself. The HTTP layer blanks `authInfo.token` and removes the `Authorization` header from the request handlers can read as `ctx.http.req`, because the MCP spec forbids passing a client's token to another API. To act on the user's behalf somewhere else, exchange the token for one issued for that API ([RFC 8693](https://datatracker.ietf.org/doc/html/rfc8693)) inside the verifier, and keep the result in `extra`.

## Verify tokens another way

To use opaque tokens with [introspection (RFC 7662)](https://datatracker.ietf.org/doc/html/rfc7662), a static key for private deployments, or anything else, return your own `OAuthTokenVerifier` from `createVerifier` in `src/server.ts`:

```ts
export function createVerifier(oauth: OAuthConfig, deps: Deps): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token) {
      const claims = await deps.introspection.check(token); // your service
      if (!claims.active) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token is not active');
      // `aud` may be one value or a list: report this server's entry.
      const audience = [claims.aud].flat().find((aud) => aud === deps.config.publicUrl.href);
      if (!audience) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token is for another server');
      return {
        token,
        clientId: claims.client_id,
        scopes: claims.scope.split(' '),
        expiresAt: claims.exp,
        resource: new URL(audience),
      };
    },
  };
}
```

Throw `OAuthError(OAuthErrorCode.InvalidToken, …)` for a bad token; any other error becomes a `500`. Always set `expiresAt` and `resource`: the gate rejects tokens without them. `OAUTH_JWKS_URL` is only needed by the built-in JWT verifier, so leave it unset.
