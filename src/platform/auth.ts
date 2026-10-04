import {
  type AuthInfo,
  type AuthMetadataOptions,
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
  requireBearerAuth,
} from '@modelcontextprotocol/server';
import type { Config, OAuthConfig } from './config';
import { createJwtVerifier } from './jwt';
import type { Logger } from './logger';

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
 * authorization server. Fails at startup, not on the first request, if metadata is invalid.
 */
export function createAuth(
  config: Config,
  oauth: OAuthConfig,
  resourceName: string,
  logger: Logger,
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

  const verifier = createJwtVerifier(
    { issuer: oauth.issuer, jwksUrl: oauth.jwksUrl, audience: config.publicUrl.href },
    logger,
  );

  return {
    metadata: (request) => oauthMetadataResponse(request, metadata),
    gate: requireBearerAuth({
      verifier,
      requiredScopes: oauth.scopes,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.publicUrl),
      // Accept only tokens issued for this server, whatever the verifier.
      expectedResource: config.publicUrl,
    }),
  };
}
