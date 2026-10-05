# Changelog

## Unreleased

### Added

- Tests for the `MCP-Protocol-Version` header on 2025-era requests after initialize:
  - every supported version is served;
  - a missing header is served as `2025-03-26`;
  - any other value gets a clean `400` before a handler runs.

  A further test checks that the SDK client sends the negotiated version on every request, in both protocol eras.

## 2.0.0 — 2026-10-05

Verified against `@modelcontextprotocol/server` and `@modelcontextprotocol/client` **2.3.0**, protocol `2026-07-28`, with 2025-era clients served through the SDK's stateless fallback.

A rewrite around the SDK's recommended remote-server setup. Projects started from 1.x should start again from this version.

### Added

- **`defineTool`, `defineResource` and `definePrompt`.** They take the SDK's registration signatures, pass dependencies as the handler's last argument, and apply one error policy to tool calls, resource reads, template `list`/`complete` callbacks and prompt gets. Unexpected errors are logged with a reference; the client sees only the reference. With an `outputSchema`, tools must return matching `structuredContent`, checked at compile time. Resource templates can be built from dependencies.
- **Samples that each show one pattern:**
  - A weather tool backed by Open-Meteo: services, cancellation, progress, recoverable errors, and an optional API key.
  - `whoami`, which reads the verified caller.
  - `confirm-action`, which shows `input_required` and a per-tool OAuth scope.
  - A static resource, a resource template with completion, and a prompt with completion.
- **OAuth resource-server mode.** Tokens must be issued for this server (audience checked by the verifier and again by `expectedResource`). Per-tool scope challenges and RFC 9728 metadata are supported. Handlers see the verified caller but neither the token nor the `Authorization` header. Token verification is chosen in `createVerifier` in `src/server.ts`.
- **`src/settings.ts`** for your own settings, such as API keys, validated together with the platform's configuration.
- **A `routes` hook in `src/server.ts`** for HTTP routes outside MCP, such as webhooks and OAuth callbacks. They sit behind the same Host and Origin checks.
- **`bun run token`:** a local authorization server for trying OAuth, with a key that survives restarts.
- **Tests:**
  - In-process tests per tool and per service, as the SDK's testing guide recommends.
  - Platform tests that run against a fixture server, so they don't depend on the samples.
  - Smoke tests that run the real server on Bun, and on workerd in OAuth mode.
- `bun run check`, GitHub Actions CI, a `production` Wrangler environment, `docs/`, and a LICENSE file.

### Changed

- **SDK 2.3.0:** JSON-RPC batches are capped at 100 messages, `MCP-Protocol-Version` is required on 2026-07-28 requests, and tool schemas are converted lazily.
- **Server identity** (name, version, instructions) moved from environment variables into `src/server.ts`. `package.json` no longer carries a version.
- **Configuration:**
  - It is validated in one pass that reports every problem at once.
  - Production requires `MCP_PUBLIC_URL` and `AUTH_MODE`.
  - Host and Origin allowlist entries are validated, and the Host allowlist must include the public hostname.
- **Auth settings:** `AUTH_ENABLED` is replaced by `AUTH_MODE` (`none` or `oauth`). The token audience is always `MCP_PUBLIC_URL`. `OAUTH_JWKS_URL` is required only by the built-in JWT verifier.
- **Startup:** the server is built once when the app is created, so registration mistakes are caught there: Bun refuses to start, and a Worker logs the error once and answers a generic 500.
- **Key-set failures:** a key set that is unreachable, answers an error, or isn't a key set now answers `500` instead of `401 invalid_token`, and is logged at `error`.
- **Bun:** `idleTimeout` is raised so SSE streams survive quiet periods. On shutdown, requests in progress get time to finish.
- **CORS:** preflight accepts any request header from an allowed origin.
- **Change notifications** are no longer advertised. Nothing published them, and listeners waited forever.

### Removed

- The hand-written request-body reader. The SDK's `maxRequestBodySize` limit applies instead.
- Environment variables `MCP_NAME`, `MCP_TITLE`, `MCP_VERSION`, `MCP_DESCRIPTION`, `MCP_INSTRUCTIONS`, `MCP_WEBSITE_URL`, `AUTH_ENABLED`, `OAUTH_AUDIENCE`, `OAUTH_REQUIRED_SCOPES` (now `OAUTH_SCOPES`), `OAUTH_JWT_ALGORITHMS`, `OAUTH_CLIENT_ID_CLAIM`, `OAUTH_RESPONSE_TYPES_SUPPORTED`, `OAUTH_GRANT_TYPES_SUPPORTED` and `OAUTH_CODE_CHALLENGE_METHODS_SUPPORTED`.
- `manual.md` and `docs/MCP_SDK_COMPATIBILITY.md`, replaced by `docs/`.
