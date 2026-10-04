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

/**
 * The algorithms tokens may be signed with (RFC 8725 asks verifiers to name them). jose
 * already refuses symmetric ones like HS256 for a key set; this also rules out the rest.
 */
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
 * `OAuthTokenVerifier` from `createVerifier` in `src/server.ts`.
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

      // Report the audience the token itself names, as the SDK expects: its `expectedResource`
      // check then verifies it a second time, independently of this function.
      const audience = [payload.aud ?? []].flat().find((entry) => entry === options.audience);
      const subject = stringClaim(payload.sub);
      return {
        token,
        clientId,
        scopes: scopesOf(payload),
        expiresAt: payload.exp as number,
        ...(audience && { resource: new URL(audience) }),
        ...(subject && { extra: { subject } }),
      };
    },
  };
}

/**
 * A token we could not check is not an invalid token. When the key set cannot be fetched or
 * read (network failure, timeout, an error status, a body that isn't a JWKS), answer 500 so
 * clients keep the token and retry instead of starting a new authorization.
 */
function toOAuthError(error: unknown, logger: Logger): OAuthError {
  const keySetUnavailable =
    !(error instanceof errors.JOSEError) ||
    error instanceof errors.JWKSTimeout ||
    error instanceof errors.JWKSInvalid ||
    // jose reports a non-200 or non-JSON key set response with its generic error class.
    error.code === errors.JOSEError.code;

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
