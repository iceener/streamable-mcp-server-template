import {
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import type { AppConfig } from '../../config/env.js';

function scopesFromClaims(payload: Record<string, unknown>): string[] {
  const scope = payload.scope;
  if (typeof scope === 'string') {
    return [...new Set(scope.split(/\s+/).filter(Boolean))];
  }

  const scp = payload.scp;
  if (Array.isArray(scp) && scp.every((value) => typeof value === 'string')) {
    return [...new Set(scp)];
  }

  return [];
}

/**
 * Create a verifier for JWT access tokens issued by an external Authorization Server.
 * Signature, issuer, audience, algorithm, and expiry are all checked before AuthInfo
 * reaches MCP handlers.
 */
export function createJwtVerifier(config: AppConfig): OAuthTokenVerifier {
  if (!config.OAUTH_ISSUER_URL || !config.OAUTH_JWKS_URL || !config.OAUTH_AUDIENCE) {
    throw new Error('JWT verifier requires issuer, JWKS URL, and audience');
  }

  const audience = config.OAUTH_AUDIENCE;
  const resource = new URL(audience);
  resource.hash = '';
  const jwks = createRemoteJWKSet(config.OAUTH_JWKS_URL);

  return {
    async verifyAccessToken(token) {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: config.OAUTH_ISSUER_URL,
          audience,
          algorithms: config.OAUTH_JWT_ALGORITHMS,
        });

        const clientId = payload[config.OAUTH_CLIENT_ID_CLAIM];
        if (typeof clientId !== 'string' || clientId.length === 0) {
          throw new OAuthError(
            OAuthErrorCode.InvalidToken,
            `Access token is missing ${config.OAUTH_CLIENT_ID_CLAIM}`,
          );
        }
        if (typeof payload.exp !== 'number') {
          throw new OAuthError(
            OAuthErrorCode.InvalidToken,
            'Access token is missing an expiration time',
          );
        }

        return {
          token,
          clientId,
          scopes: scopesFromClaims(payload),
          expiresAt: payload.exp,
          resource,
          extra: {
            ...(typeof payload.sub === 'string' ? { subject: payload.sub } : {}),
          },
        };
      } catch (error) {
        if (error instanceof OAuthError) throw error;
        if (error instanceof errors.JOSEError) {
          throw new OAuthError(
            OAuthErrorCode.InvalidToken,
            'Access token is invalid or expired',
          );
        }
        throw error;
      }
    },
  };
}
