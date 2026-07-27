import {
  type AuthInfo,
  type AuthMetadataOptions,
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
  type OAuthTokenVerifier,
  requireBearerAuth,
} from '@modelcontextprotocol/server';
import type { AppConfig } from '../config/env.js';
import { createJwtVerifier } from '../shared/auth/jwt-verifier.js';

export interface AuthServices {
  gate: (request: Request) => Promise<AuthInfo | Response>;
  metadata: AuthMetadataOptions;
}

/** Build the optional OAuth Resource Server boundary. */
export function createAuthServices(
  config: AppConfig,
  verifier?: OAuthTokenVerifier,
): AuthServices | undefined {
  if (!config.AUTH_ENABLED) return undefined;
  const tokenVerifier = verifier ?? createJwtVerifier(config);
  if (
    !config.OAUTH_ISSUER_URL ||
    !config.OAUTH_AUTHORIZATION_URL ||
    !config.OAUTH_TOKEN_URL
  ) {
    throw new Error('OAuth Resource Server metadata is incomplete');
  }

  const metadata: AuthMetadataOptions = {
    oauthMetadata: {
      issuer: config.OAUTH_ISSUER_URL,
      authorization_endpoint: config.OAUTH_AUTHORIZATION_URL.href,
      token_endpoint: config.OAUTH_TOKEN_URL.href,
      response_types_supported: config.OAUTH_RESPONSE_TYPES_SUPPORTED,
      grant_types_supported: config.OAUTH_GRANT_TYPES_SUPPORTED,
      code_challenge_methods_supported: config.OAUTH_CODE_CHALLENGE_METHODS_SUPPORTED,
      scopes_supported: config.OAUTH_REQUIRED_SCOPES,
      ...(config.OAUTH_REGISTRATION_URL
        ? { registration_endpoint: config.OAUTH_REGISTRATION_URL.href }
        : {}),
    },
    resourceServerUrl: config.MCP_PUBLIC_URL,
    scopesSupported: config.OAUTH_REQUIRED_SCOPES,
    resourceName: config.MCP_TITLE,
    ...(config.MCP_WEBSITE_URL
      ? { serviceDocumentationUrl: config.MCP_WEBSITE_URL }
      : {}),
    dangerouslyAllowInsecureIssuerUrl: config.NODE_ENV !== 'production',
  };

  // Validate issuer and resource metadata once, during runtime construction.
  buildOAuthProtectedResourceMetadata(metadata);

  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(
    config.MCP_PUBLIC_URL,
  );

  return {
    metadata,
    gate: requireBearerAuth({
      verifier: tokenVerifier,
      requiredScopes: config.OAUTH_REQUIRED_SCOPES,
      resourceMetadataUrl,
    }),
  };
}
