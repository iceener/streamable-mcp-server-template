import {
  type AuthInfo,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import { createRemoteJWKSet, errors, type JWTPayload, jwtVerify } from 'jose';
import type { Logger } from './logger';

export interface JwtVerifierOptions {
  /** Exact `iss` claim. */
  issuer: string;
  /** Where the authorization server publishes its signing keys. */
  jwksUrl: URL;
  /** Exact `aud` entry tokens for this server carry: its public MCP URL (RFC 8707). */
  audience: string;
}

/** Asymmetric algorithms only: a JWKS never holds the shared secret an HS* token needs. */
const ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
];

/** Tolerated clock difference between this server and the authorization server. */
const CLOCK_TOLERANCE_SECONDS = 30;

/**
 * Verify JWT access tokens (RFC 9068) locally against the authorization server's JWKS.
 * Signature, issuer, audience, expiry and not-before are all checked before any handler runs.
 *
 * To verify tokens another way, such as RFC 7662 introspection, return your own
 * `OAuthTokenVerifier` from `createAuth` in `auth.ts`. Nothing else changes.
 */
export function createJwtVerifier(options: JwtVerifierOptions, logger: Logger): OAuthTokenVerifier {
  const keys = createRemoteJWKSet(options.jwksUrl, { timeoutDuration: 5_000 });

  return {
    async verifyAccessToken(token): Promise<AuthInfo> {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, keys, {
          issuer: options.issuer,
          audience: options.audience,
          algorithms: ALGORITHMS,
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
          requiredClaims: ['exp'],
        }));
      } catch (error) {
        throw toOAuthError(error, logger);
      }

      const clientId = stringClaim(payload.client_id) ?? stringClaim(payload.azp);
      if (!clientId) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'Access token has no client_id or azp');
      }

      const subject = stringClaim(payload.sub);
      return {
        token,
        clientId,
        scopes: scopesOf(payload),
        expiresAt: payload.exp as number,
        // jose accepted the token only because `aud` contains this exact value.
        resource: new URL(options.audience),
        ...(subject && { extra: { subject } }),
      };
    },
  };
}

/**
 * A token we could not check is not an invalid token. When the key set cannot be fetched,
 * answer 500 so clients keep the token and retry instead of starting a new authorization.
 */
function toOAuthError(error: unknown, logger: Logger): OAuthError {
  const keySetUnavailable =
    !(error instanceof errors.JOSEError) ||
    error instanceof errors.JWKSTimeout ||
    error instanceof errors.JWKSInvalid;

  if (keySetUnavailable) {
    logger.error('Could not load the authorization server key set', { error });
    return new OAuthError(OAuthErrorCode.ServerError, 'Token verification is unavailable');
  }

  logger.debug('Rejected access token', { reason: error.code, detail: error.message });
  return new OAuthError(OAuthErrorCode.InvalidToken, 'Access token is invalid or expired');
}

/** `scope` is a space-separated string (RFC 9068); some servers use `scp`, string or array. */
function scopesOf(payload: JWTPayload): string[] {
  const claim = payload.scope ?? payload.scp;
  const scopes = typeof claim === 'string' ? claim.split(' ') : Array.isArray(claim) ? claim : [];
  return [
    ...new Set(
      scopes.filter((scope): scope is string => typeof scope === 'string' && scope !== ''),
    ),
  ];
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
