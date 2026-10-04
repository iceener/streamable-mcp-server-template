# Changelog

## 2.0.0 — 2026-10-05

Verified against `@modelcontextprotocol/server` and `@modelcontextprotocol/client` **2.3.0**, protocol `2026-07-28`, with 2025-era clients served through the SDK's stateless fallback.

A rewrite around the SDK's recommended remote-server setup. Projects started from 1.x should start again from this version.

### Added

- `defineTool`, `defineResource` and `definePrompt`: the SDK's registration signatures, plus dependencies as the handler's last argument, plus one error policy. Unexpected errors are logged with a reference and never shown to clients.
- Samples that each show one pattern. A weather tool backed by Open-Meteo covers services, cancellation, progress and recoverable errors. `whoami` reads the caller. `confirm-action` shows `input_required` and a per-tool OAuth scope. There is also a static resource, a resource template with completion, and a prompt with completion.
- OAuth resource-server mode with audience binding (`expectedResource`), per-tool scope challenges, and RFC 9728 metadata. The raw bearer token is removed before any handler runs.
- `bun run token`: a local authorization server for trying OAuth.
- In-process tests per tool, as the SDK's testing guide recommends. Platform tests run against a fixture server and don't depend on the samples. Smoke tests run the real server on Bun and on workerd.
- `bun run check`, GitHub Actions CI, a `production` Wrangler environment, `docs/`, and a LICENSE file.

### Changed

- SDK 2.3.0: JSON-RPC batches are capped at 100 messages, `MCP-Protocol-Version` is required on 2026-07-28 requests, and tool schemas are converted lazily.
- Server identity (name, version, instructions) moved from environment variables into `src/server.ts`.
- Configuration is validated with one schema, and every problem is reported at once. Production requires `MCP_PUBLIC_URL` and `AUTH_MODE`. Host and Origin allowlist entries are validated.
- `AUTH_ENABLED` is replaced by `AUTH_MODE` (`none` or `oauth`). The token audience is always `MCP_PUBLIC_URL`.
- A JWKS outage now answers `500` instead of `401 invalid_token`.
- Bun's `idleTimeout` is raised so SSE streams survive quiet periods. On shutdown, requests in progress get time to finish.
- Change notifications are no longer advertised. Nothing published them, and listeners waited forever.

### Removed

- The hand-written request-body reader. The SDK's `maxRequestBodySize` limit applies instead.
- Environment variables `MCP_NAME`, `MCP_TITLE`, `MCP_VERSION`, `MCP_DESCRIPTION`, `MCP_INSTRUCTIONS`, `MCP_WEBSITE_URL`, `AUTH_ENABLED`, `OAUTH_AUDIENCE`, `OAUTH_REQUIRED_SCOPES` (now `OAUTH_SCOPES`), `OAUTH_JWT_ALGORITHMS`, `OAUTH_CLIENT_ID_CLAIM`, `OAUTH_RESPONSE_TYPES_SUPPORTED`, `OAUTH_GRANT_TYPES_SUPPORTED` and `OAUTH_CODE_CHALLENGE_METHODS_SUPPORTED`.
- `manual.md` and `docs/MCP_SDK_COMPATIBILITY.md`, replaced by `docs/`.
