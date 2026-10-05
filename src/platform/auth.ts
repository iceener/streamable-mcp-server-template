import {
  type AuthInfo,
  type AuthMetadataOptions,
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
  type OAuthTokenVerifier,
  oauthMetadataResponse,
  requireBearerAuth,
} from '@modelcontextprotocol/server';
import type { Config, OAuthConfig } from './config';

/** The OAuth resource-server boundary in front of the MCP endpoint. */
export interface Auth {
  /** Serve the OAuth discovery documents, or return `undefined` for any other path. */
  metadata(request: Request): Response | undefined;
  /** The verified caller, or the 401/403 challenge response to send back. */
  gate(request: Request): Promise<AuthInfo | Response>;
}

/**
 * Build the boundary from the SDK's own pieces: `requireBearerAuth` checks the token,
 * `oauthMetadataResponse` publishes RFC 9728 metadata so clients can find the
 * authorization server. Invalid metadata throws here, when the app is built.
 */
export function createAuth(
  config: Config,
  oauth: OAuthConfig,
  verifier: OAuthTokenVerifier,
  resourceName: string,
): Auth {
  const metadata: AuthMetadataOptions = {
    // Mirrored at /.well-known/oauth-authorization-server for clients that look for the
    // authorization server on this origin. MCP requires authorization code flow with PKCE S256.
    oauthMetadata: {
      issuer: oauth.issuer,
      authorization_endpoint: oauth.authorizationUrl.href,
      token_endpoint: oauth.tokenUrl.href,
      ...(oauth.registrationUrl && { registration_endpoint: oauth.registrationUrl.href }),
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
    },
    resourceServerUrl: config.publicUrl,
    resourceName,
    ...(oauth.scopes.length > 0 && { scopesSupported: oauth.scopes }),
    // Config already restricts plain http to loopback hosts outside production.
    dangerouslyAllowInsecureIssuerUrl: config.environment !== 'production',
  };
  buildOAuthProtectedResourceMetadata(metadata);

  return {
    metadata: (request) => oauthMetadataResponse(request, metadata),
    gate: requireBearerAuth({
      verifier,
      requiredScopes: oauth.scopes,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.publicUrl),
      // Only tokens issued for this server: compares the `resource` the verifier reports.
      expectedResource: config.publicUrl,
    }),
  };
}
