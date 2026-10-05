import {
  type AuthInfo,
  type AuthMetadataOptions,
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
  OAuthError,
  OAuthErrorCode,
  type OAuthMetadata,
  type OAuthTokenVerifier,
  oauthMetadataResponse,
  requireBearerAuth,
} from '@modelcontextprotocol/server';
import type { Config, OAuthConfig } from './config';

/** The authentication boundary in front of the MCP endpoint. */
export interface Auth {
  /** Serve the OAuth discovery documents, or return `undefined` for any other path. */
  metadata(request: Request): Response | undefined;
  /** The verified caller, or the 401/403 challenge response to send back. */
  gate(request: Request): Promise<AuthInfo | Response>;
}

export interface OAuthAuthOptions {
  verifier: OAuthTokenVerifier;
  /** Published at /.well-known/oauth-authorization-server. */
  authorizationServer: OAuthMetadata;
  resourceName: string;
}

/**
 * `AUTH_MODE=oauth`: this server is an OAuth resource server. Built from the SDK's own pieces:
 * `requireBearerAuth` checks the token, `oauthMetadataResponse` publishes RFC 9728 metadata
 * so clients can find the authorization server. Invalid metadata throws here, when the app is
 * built.
 */
export function createOAuthAuth(
  config: Config,
  oauth: OAuthConfig,
  options: OAuthAuthOptions,
): Auth {
  const metadata: AuthMetadataOptions = {
    oauthMetadata: options.authorizationServer,
    resourceServerUrl: config.publicUrl,
    resourceName: options.resourceName,
    ...(oauth.scopes.length > 0 && { scopesSupported: oauth.scopes }),
    // Config already restricts plain http to loopback hosts outside production.
    dangerouslyAllowInsecureIssuerUrl: config.environment !== 'production',
  };
  buildOAuthProtectedResourceMetadata(metadata);

  return {
    metadata: (request) => oauthMetadataResponse(request, metadata),
    gate: requireBearerAuth({
      verifier: options.verifier,
      requiredScopes: oauth.scopes,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.publicUrl),
      // Only tokens issued for this server: compares the `resource` the verifier reports.
      expectedResource: config.publicUrl,
    }),
  };
}

/**
 * `AUTH_MODE=bearer`: every client sends the same secret, `BEARER_TOKEN`. There is no OAuth
 * discovery, so the 401 names no metadata and clients don't try to sign in; the operator gives
 * them the token instead.
 */
export function createBearerAuth(config: Config, token: string): Auth {
  const expected = digest(token);

  return {
    metadata: () => undefined,
    gate: requireBearerAuth({
      expectedResource: config.publicUrl,
      verifier: {
        async verifyAccessToken(candidate): Promise<AuthInfo> {
          if (!equalBytes(await digest(candidate), await expected)) {
            throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid bearer token');
          }
          return {
            token: candidate,
            clientId: 'bearer',
            scopes: [],
            // The SDK requires an expiry. This token never expires; this request is valid now.
            expiresAt: Math.floor(Date.now() / 1000) + 60,
            resource: config.publicUrl,
          };
        },
      },
    }),
  };
}

/** Compare fixed-length digests, so the time taken says nothing about the token. */
async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
