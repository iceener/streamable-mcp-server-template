/**
 * MCP endpoint handler for Cloudflare Workers.
 * Uses the shared dispatcher for JSON-RPC processing.
 */

import type { UnifiedConfig } from '../../shared/config/env.js';
import { withCors } from '../../shared/http/cors.js';
import { jsonResponse } from '../../shared/http/response.js';
import {
  type CancellationRegistry,
  dispatchMcpMethod,
  handleMcpNotification,
  type McpDispatchContext,
  type McpSessionState,
} from '../../shared/mcp/dispatcher.js';
import {
  ensureFreshToken,
  type ProviderRefreshConfig,
} from '../../shared/oauth/refresh.js';
import type { SessionStore, TokenStore } from '../../shared/storage/interface.js';
import type { AuthStrategy, ToolContext } from '../../shared/tools/types.js';
import { sharedLogger as logger } from '../../shared/utils/logger.js';
import { checkAuthAndChallenge } from './security.js';

// ─────────────────────────────────────────────────────────────────────────────
// Session State (in-memory, persists within worker instance)
// Note: These are ephemeral in Workers - each request may hit a different isolate
// ─────────────────────────────────────────────────────────────────────────────

const sessionStateMap = new Map<string, McpSessionState>();

// Cancellation registry for tracking in-flight requests per session
// This enables notifications/cancelled to abort running tool calls
const cancellationRegistryMap = new Map<string, CancellationRegistry>();

/**
 * Get or create cancellation registry for a session.
 */
function getCancellationRegistry(sessionId: string): CancellationRegistry {
  let registry = cancellationRegistryMap.get(sessionId);
  if (!registry) {
    registry = new Map();
    cancellationRegistryMap.set(sessionId, registry);
  }
  return registry;
}

type JsonRpcLike = {
  method?: string;
  params?: Record<string, unknown>;
};

function getJsonRpcMessages(body: unknown): JsonRpcLike[] {
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body)) {
    return body.filter((msg) => msg && typeof msg === 'object') as JsonRpcLike[];
  }
  return [body as JsonRpcLike];
}

function resolveSessionApiKey(headers: Headers, config: UnifiedConfig): string {
  const apiKeyHeader = config.API_KEY_HEADER.toLowerCase();
  const directApiKey =
    headers.get(apiKeyHeader) || headers.get('x-api-key') || headers.get('x-auth-token');
  if (directApiKey) return directApiKey;

  const authHeader = headers.get('authorization') || headers.get('Authorization');
  if (authHeader) {
    const match = authHeader.match(/^\s*Bearer\s+(.+)$/i);
    return match?.[1] ?? authHeader;
  }

  if (config.API_KEY) return config.API_KEY;

  return 'public';
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse custom headers from config string.
 * Format: "X-Header-1:value1,X-Header-2:value2"
 */
function parseCustomHeaders(value: string | undefined): Record<string, string> {
  if (!value) return {};

  const headers: Record<string, string> = {};
  for (const pair of value.split(',')) {
    const colonIndex = pair.indexOf(':');
    if (colonIndex === -1) continue;

    const key = pair.slice(0, colonIndex).trim();
    const val = pair.slice(colonIndex + 1).trim();
    if (key && val) {
      headers[key.toLowerCase()] = val;
    }
  }

  return headers;
}

/**
 * Build static auth headers from config.
 */
function buildStaticAuthHeaders(config: UnifiedConfig): Record<string, string> {
  const headers: Record<string, string> = {};

  switch (config.AUTH_STRATEGY) {
    case 'api_key':
      if (config.API_KEY) {
        headers[config.API_KEY_HEADER.toLowerCase()] = config.API_KEY;
      }
      break;
    case 'bearer':
      if (config.BEARER_TOKEN) {
        headers.authorization = `Bearer ${config.BEARER_TOKEN}`;
      }
      break;
    case 'custom':
      Object.assign(headers, parseCustomHeaders(config.CUSTOM_HEADERS));
      break;
  }

  return headers;
}

/**
 * Build provider config for token refresh from unified config.
 */
function buildProviderRefreshConfig(
  config: UnifiedConfig,
): ProviderRefreshConfig | undefined {
  if (
    !config.PROVIDER_CLIENT_ID ||
    !config.PROVIDER_CLIENT_SECRET ||
    !config.PROVIDER_ACCOUNTS_URL
  ) {
    return undefined;
  }
  return {
    clientId: config.PROVIDER_CLIENT_ID,
    clientSecret: config.PROVIDER_CLIENT_SECRET,
    accountsUrl: config.PROVIDER_ACCOUNTS_URL,
    tokenEndpointPath: config.OAUTH_TOKEN_URL,
  };
}

/**
 * Resolve auth context from request and config.
 * Includes proactive token refresh for OAuth strategy.
 */
async function resolveAuthContext(
  request: Request,
  tokenStore: TokenStore,
  config: UnifiedConfig,
): Promise<ToolContext> {
  // Extract raw headers
  const rawHeaders: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    rawHeaders[key.toLowerCase()] = value;
  });

  const strategy = config.AUTH_STRATEGY as AuthStrategy;
  let providerToken: string | undefined;
  let provider: ToolContext['provider'];
  let resolvedHeaders = { ...rawHeaders };

  if (strategy === 'oauth') {
    // OAuth: map RS token to provider token
    const authHeader = rawHeaders.authorization;
    const match = authHeader?.match(/^\s*Bearer\s+(.+)$/i);
    const rsToken = match?.[1];

    if (rsToken) {
      try {
        // Proactively refresh token if near expiry
        const providerConfig = buildProviderRefreshConfig(config);
        const { accessToken, wasRefreshed } = await ensureFreshToken(
          rsToken,
          tokenStore,
          providerConfig,
        );

        if (accessToken) {
          providerToken = accessToken;

          // Re-fetch record if it was refreshed to get updated info
          const record = await tokenStore.getByRsAccess(rsToken);
          if (record?.provider) {
            provider = {
              accessToken: record.provider.access_token,
              refreshToken: record.provider.refresh_token,
              expiresAt: record.provider.expires_at,
              scopes: record.provider.scopes,
            };
          }

          resolvedHeaders.authorization = `Bearer ${accessToken}`;

          if (wasRefreshed) {
            logger.info('mcp_handler', {
              message: 'Using proactively refreshed token',
            });
          }
        }
      } catch (error) {
        logger.debug('mcp_handler', {
          message: 'Token resolution failed',
          error: (error as Error).message,
        });
      }
    }
  } else if (strategy === 'bearer' || strategy === 'api_key' || strategy === 'custom') {
    // Static auth: use config values
    const staticHeaders = buildStaticAuthHeaders(config);
    resolvedHeaders = { ...rawHeaders, ...staticHeaders };
    providerToken = strategy === 'bearer' ? config.BEARER_TOKEN : config.API_KEY;
  }

  return {
    sessionId: '', // Will be set by caller
    authStrategy: strategy,
    providerToken,
    provider,
    resolvedHeaders,
    authHeaders: rawHeaders,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Request Handler
// ─────────────────────────────────────────────────────────────────────────────

export interface McpHandlerDeps {
  tokenStore: TokenStore;
  sessionStore: SessionStore;
  config: UnifiedConfig;
}

/**
 * Handle MCP POST request.
 */
export async function handleMcpRequest(
  request: Request,
  deps: McpHandlerDeps,
): Promise<Response> {
  const { tokenStore, sessionStore, config } = deps;

  // Parse JSON-RPC body
  const body = (await request.json().catch(() => ({}))) as {
    jsonrpc?: string;
    method?: string;
    params?: Record<string, unknown>;
    id?: string | number | null;
  };

  const { method, params, id } = body;
  const messages = getJsonRpcMessages(body);
  const isInitialize = messages.some((msg) => msg.method === 'initialize');
  const isInitialized = messages.some((msg) => msg.method === 'initialized');
  const initMessage = messages.find((msg) => msg.method === 'initialize');
  const protocolVersion =
    typeof (initMessage?.params as { protocolVersion?: string } | undefined)
      ?.protocolVersion === 'string'
      ? (initMessage?.params as { protocolVersion?: string }).protocolVersion
      : undefined;

  // Get or create session ID
  // Server always generates session ID on initialize (per MCP spec)
  // Ignore client-provided session ID to prevent session fixation
  const incomingSessionId = request.headers.get('Mcp-Session-Id')?.trim();
  const sessionId = isInitialize ? crypto.randomUUID() : (incomingSessionId || crypto.randomUUID());
  const apiKey = resolveSessionApiKey(request.headers, config);

  if (!isInitialize && !incomingSessionId) {
    return jsonResponse(
      {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: Mcp-Session-Id required' },
        id: null,
      },
      { status: 400 },
    );
  }

  if (!isInitialize && incomingSessionId) {
    let existingSession: Awaited<ReturnType<typeof sessionStore.get>> | null = null;
    try {
      existingSession = await sessionStore.get(incomingSessionId);
    } catch (error) {
      logger.warning('mcp_session', {
        message: 'Session lookup failed',
        error: (error as Error).message,
      });
    }
    if (!existingSession) {
      return withCors(new Response('Invalid session', { status: 404 }));
    }
    // Warn if API key changed but don't reject - allows legitimate re-auth scenarios
    // Session stays bound to original API key for limit enforcement
    if (existingSession.apiKey && existingSession.apiKey !== apiKey) {
      logger.warning('mcp_session', {
        message: 'Request API key differs from session binding',
        sessionId: incomingSessionId,
        originalApiKey: existingSession.apiKey.slice(0, 8) + '...',
        requestApiKey: apiKey.slice(0, 8) + '...',
      });
    }
  }

  // Check auth and get challenge response if needed
  // Do this BEFORE creating session to avoid orphans on auth failure
  const challengeResponse = await checkAuthAndChallenge(
    request,
    tokenStore,
    config,
    sessionId,
  );
  if (challengeResponse) {
    return challengeResponse;
  }

  // Resolve auth context
  const authContext = await resolveAuthContext(request, tokenStore, config);
  authContext.sessionId = sessionId;

  // Create session record AFTER auth passes (prevents orphans)
  if (isInitialize) {
    try {
      await sessionStore.create(sessionId, apiKey);
      if (protocolVersion) {
        await sessionStore.update(sessionId, { protocolVersion });
      }
    } catch (error) {
      logger.warning('mcp_session', {
        message: 'Failed to create session record',
        error: (error as Error).message,
      });
    }
  }

  if (isInitialized) {
    try {
      await sessionStore.update(sessionId, { initialized: true });
    } catch (error) {
      logger.warning('mcp_session', {
        message: 'Failed to update session initialized flag',
        error: (error as Error).message,
      });
    }
  }

  // Get cancellation registry for this session
  const cancellationRegistry = getCancellationRegistry(sessionId);

  // Build dispatch context
  const dispatchContext: McpDispatchContext = {
    sessionId,
    auth: authContext,
    config: {
      title: config.MCP_TITLE,
      version: config.MCP_VERSION,
      instructions: config.MCP_INSTRUCTIONS,
    },
    getSessionState: () => sessionStateMap.get(sessionId),
    setSessionState: (state) => sessionStateMap.set(sessionId, state),
    cancellationRegistry,
  };

  // Handle notifications (no id) - return 202 Accepted
  if (!('id' in body) || id === null || id === undefined) {
    if (method) {
      handleMcpNotification(method, params, dispatchContext);
    }
    return withCors(new Response(null, { status: 202 }));
  }

  // Dispatch JSON-RPC request with requestId for cancellation tracking
  const result = await dispatchMcpMethod(method, params, dispatchContext, id);

  // Build response
  const response = jsonResponse({
    jsonrpc: '2.0',
    ...(result.error ? { error: result.error } : { result: result.result }),
    id,
  });

  response.headers.set('Mcp-Session-Id', sessionId);
  return withCors(response);
}

/**
 * Handle MCP GET request (returns 405 per spec).
 */
export function handleMcpGet(): Response {
  return withCors(new Response('Method Not Allowed', { status: 405 }));
}

/**
 * Handle MCP DELETE request (session termination).
 */
export async function handleMcpDelete(
  request: Request,
  deps: McpHandlerDeps,
): Promise<Response> {
  const { sessionStore } = deps;
  const sessionId = request.headers.get('Mcp-Session-Id')?.trim();

  if (!sessionId) {
    return withCors(
      jsonResponse(
        {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: Mcp-Session-Id required' },
          id: null,
        },
        { status: 400 },
      ),
    );
  }

  // Validate session exists
  let existingSession: Awaited<ReturnType<typeof sessionStore.get>> | null = null;
  try {
    existingSession = await sessionStore.get(sessionId);
  } catch (error) {
    logger.warning('mcp_session', {
      message: 'Session lookup failed on DELETE',
      error: (error as Error).message,
    });
  }

  if (!existingSession) {
    return withCors(new Response('Invalid session', { status: 404 }));
  }

  // Clean up session state and registry
  sessionStateMap.delete(sessionId);
  cancellationRegistryMap.delete(sessionId);

  // Delete from persistent store
  try {
    await sessionStore.delete(sessionId);
    logger.info('mcp_session', {
      message: 'Session terminated via DELETE',
      sessionId,
    });
  } catch (error) {
    logger.warning('mcp_session', {
      message: 'Failed to delete session record',
      error: (error as Error).message,
    });
  }

  return withCors(new Response(null, { status: 202 }));
}
