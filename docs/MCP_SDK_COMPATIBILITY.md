# MCP SDK compatibility — reusable template

## Verdict and provenance (2026-09-08)

**Current verdict:** compatible with the exercised **published SDK 2.0.0** APIs and wire behavior on Bun and local workerd. All validation commands below pass. This is not a full current-spec conformance certification, an external OAuth-flow test, or a deployment approval.

- Runtime: `@modelcontextprotocol/server` **2.0.0**.
- Test/smoke client: `@modelcontextprotocol/client` **2.0.0**.
- Transitive SDK core: **2.0.0**; no mixed SDK versions.
- Published npm artifacts: [server](https://registry.npmjs.org/@modelcontextprotocol/server/-/server-2.0.0.tgz), [client](https://registry.npmjs.org/@modelcontextprotocol/client/-/client-2.0.0.tgz). Their integrity hashes are retained in `bun.lock`.
- Audited official source checkout: `modelcontextprotocol/typescript-sdk` HEAD `5119ee7fd7790e335a3fb60ef36f85334e2a6326`. Its `main` contains unreleased changes and is **not** the implementation target.
- Parent audit artifacts: `../.mcp-sdk-audit/published/{server,client}/package`. `diff -qr` against each installed package returned no differences; no SDK patches or private imports were added.
- Execution environment: macOS, Bun **1.4.0**, Node **24.1.0**, TypeScript **5.9.3**, Biome **2.5.5**, Wrangler **4.130.0**, workerd **2026-09-08** (`1.20260908.1`).
- Wrangler 4.130.0 requires **Node 22+** (the template's engine floor now matches) and currently depends on **Miniflare 5.20260908.0-alpha**. This is upstream tooling, not a new application framework. `@cloudflare/workers-types` is **5.20260908.1**, satisfying Wrangler's updated peer range; actual Worker checking uses generated `worker-configuration.d.ts`.

References consulted: published package exports/types/bundles, the official source changesets below, retrieved Cloudflare [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/), current Workers types and Wrangler config schema, [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [RFC 8707](https://www.rfc-editor.org/rfc/rfc8707), [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252), and [RFC 6749](https://www.rfc-editor.org/rfc/rfc6749).

## Initial state and observed failures

The initial template had exact server/client `2.0.0-beta.5` pins and a July 27 release-candidate warning. Git HEAD was `56e307c326a7f3e4b2041cd4d0504c829d391e84`; the working tree was clean on entry. No commits, index changes, pushes, deployments, or sibling edits were made. The parent backup is `../.mcp-sdk-audit/backups/_template.tar.gz`.

The parent's initial `bun run typecheck` failed because `node_modules` was absent (`tsc` missing), not because of an SDK incompatibility. After `bun install --frozen-lockfile`, the unmodified beta baseline passed typecheck, lint, format checking, and **10 tests / 82 assertions**. Changing only the SDK pins to stable and installing also passed that original suite without serving-architecture changes.

The first actual workerd smoke after changing compatibility date to `2026-09-08` **failed** with locked Wrangler 4.114.0:

```text
This Worker requires compatibility date "2026-09-08", but the newest date
supported by this server binary is "2026-07-29".
```

Type generation alone had succeeded and did not catch this runtime incompatibility. The targeted Wrangler/workerd/Miniflare update fixed it. Hono, jose, Zod, TypeScript, Biome, Bun types, and Node types retain their prior resolved versions. Lockfile changes are SDK packages, required Worker tooling/peer types, their direct dependency changes, and Bun's `configVersion` bookkeeping—not a wholesale update.

During implementation, validation also caught a new test helper's TypeScript union/index-signature mismatch and Biome's control-character-regex rule; both were corrected. Running lint concurrently with the new workerd smoke exposed a missing `.wrangler` generated-output exclusion; `biome.json` now excludes it instead of linting or modifying temporary SDK/runtime bundles. There are no remaining failed validation commands in the final gate.

## Architecture retained

```text
Bun.serve / Worker fetch
  -> Hono shell
  -> SDK Host validation
  -> public SDK OAuth metadata (when enabled)
  -> SDK application Origin validation
  -> optional external-AS Resource Server bearer gate
  -> app-owned bounded body reader
  -> createMcpHandler
  -> fresh McpServer per HTTP request
  -> shared tool / prompt / resource registrations
```

`src/core/runtime.ts` owns the deployment/isolate-scoped handler, active exchanges, and event bus. No shared principal or shared `McpServer`, v1 transport adapter, hand-written JSON-RPC dispatcher, provider OAuth proxy, or new framework was introduced. Modern requests are independent. The optional legacy fallback is stateless; modern-only deployments can select `MCP_LEGACY_MODE=reject`.

All example tools, prompts, completions, resources, cache hints, icons, progress/cancellation, and subscriptions remain registered and reachable. Cleanup was limited to redundant URL parsing/registration parsing, an unreachable fragment-clearing assignment in the verifier, a duplicate log-level type, and a test timeout left running after successful completion. No example feature was deleted just because it is optional.

## Security delta and exact identifiers

`src/config/env.ts` now validates configured URL settings even when authentication is disabled:

- HTTP(S) only; no userinfo (including empty userinfo), fragments (including an empty `#`), whitespace, or control characters.
- Production requires HTTPS, including loopback. Development/test HTTP is restricted to loopback hostnames (`localhost`, `127.0.0.1`, `[::1]`).
- Public endpoint and issuer cannot contain query delimiters; other endpoint URLs may retain legitimate query parameters.
- `MCP_PUBLIC_URL` must already equal its `URL.href` spelling. Noncanonical hostname case, explicit default port, missing root slash, or dot segments are rejected at configuration time, not silently rewritten.
- `OAUTH_AUDIENCE` must equal that configured resource **as a string** when auth is enabled; omission uses the exact resource string. Percent-escaped paths are permitted and retain their spelling. `jose.jwtVerify` receives the exact audience and issuer strings, never a normalized JWT claim.
- Published `AuthInfo.resource` is still a **URL**. The canonical-endpoint precondition makes SDK resource metadata serialization consistent with the configured identifier. No unreleased string API was imported.

JWT tests cover exact/multi-valued valid audiences, wrong audience/issuer, distinct host case/default port/escaping/trailing slash/query/fragment, expired or missing expiry, missing client ID, wrong signing key, and disallowed algorithm. Custom injected verifiers remain responsible for their own audience checks; the SDK bearer gate does not add one.

This is a deliberately stricter configuration contract. When reusing it, inspect existing endpoint/audience bytes rather than silently changing issuer metadata or existing token identifiers.

## Stable wire evidence and limitations

`tests/wire.test.ts` deliberately uses raw requests so first-party client behavior cannot hide protocol changes:

- Modern discovery and primitive list responses put identity in `result._meta['io.modelcontextprotocol/serverInfo']`, **not** `result.serverInfo`; omitted request `clientInfo` works.
- Legacy initialization still carries root `result.serverInfo` and requires both JSON and SSE Accept media types.
- Missing/mismatched `Mcp-Method`, mismatched protocol header, and missing/mismatched conditional `Mcp-Name`: **400 / -32020**.
- Missing required client capabilities metadata: **400 / -32602**; unknown revision: **400 / -32022**; invalid JSON: **400 / -32700**.
- Unsupported methods: **405**; wrong/missing JSON Content-Type: **415**; JSON with charset works. No session IDs are emitted.
- Bad Host: **403** on every route. Bad Origin: **403** on MCP/application routes; strict MCP CORS preflight and reflected allowlisted origins are checked. Public SDK OAuth metadata retains its permissive discovery CORS after Host validation, including GET/HEAD/OPTIONS and unsupported-method handling. A parent follow-up added this regression after the Resend audit exposed the shared ordering issue.
- Oversized declared or streaming bodies: **413**, including no Content-Length and a misleading small length; streaming producers are canceled once the bound is crossed.

**Known gaps must not be described as implemented:**

1. Published 2.0.0 accepts a modern envelope with the `MCP-Protocol-Version` header omitted (**200**, tested). `main`'s `.changeset/require-protocol-version-header-on-modern-post.md` rejects it, but is unreleased. Official clients still send the header. This template does not patch the SDK or add a parallel protocol validator.
2. `.changeset/request-body-size-limit.md` adds upstream body bounds/options that are not in stable. The existing `src/http/body.ts` bound is retained and tested; do not import those unreleased options.
3. `.changeset/plenty-plums-sip.md` changes **client OAuth helpers** to preserve resource strings. It is unreleased and does not change stable server `AuthInfo.resource` into a string. The template is an RS, not an OAuth client.
4. Change delivery across Worker isolates is not proven; the default event bus is isolate-local. Smokes acknowledge/close modern subscriptions; in-memory tests exercise notification delivery and cancellation. No remote AS/browser/provider flow, deployment, load, or full normative conformance suite was run.

## Executed validation gate

Run from `_template` (Worker commands are local or explicitly dry-run):

| Command | Final evidence |
| --- | --- |
| `bun install --frozen-lockfile` | Pass; no dependency changes after installation |
| `bun run typecheck` | Pass; Bun/scripts/tests and generated Worker environment targets |
| `bun run test` | Pass; **24 tests, 366 assertions, 0 failures**, three files |
| `bun run lint` | Pass; Biome checks **28 files** |
| `bun run format:check` | Pass; **28 files** |
| `bun run build` | Pass; **195 modules**, Bun bundle **0.93 MB** |
| `WRANGLER_SEND_METRICS=false bun run build:worker` | Pass; dry-run upload **763.69 KiB**, gzip **155.48 KiB**; nothing deployed |
| `WRANGLER_SEND_METRICS=false bun run types:worker` | Pass; regenerated from config and current runtime |
| `WRANGLER_SEND_METRICS=false bun run types:worker:check` | Pass; generated types up to date |
| `bun run test:smoke` | Pass; real Bun and actual workerd, each with modern and legacy official-client HTTP/SSE exchanges |
| `git diff --check` | Pass |

The smoke output for each runtime confirms both protocol eras plus raw stable metadata, Origin rejection, and a streamed oversize body. It covers tools, structured output, prompts, completion, resources/templates, progress SSE, no session IDs, and modern subscription acknowledgement/close. Bun binds directly to OS-assigned port `0`; Wrangler uses local HTTP and inspector port `0`. Clients and runtimes are closed in `finally`; the workerd client subprocess has a bounded execution timeout. No fixed test ports, provider credentials, external AS, remote bindings, account IDs, or deployment are needed. In-memory URL fixtures are not listening sockets; JWT test JWKS also uses an ephemeral loopback listener.

## Reuse steps / edit sites

1. Copy the template source, config, lockfile, tests, scripts, and docs—not its `.git`, `.env`, `node_modules`, `dist`, or `.wrangler` state. Preserve the destination repository's existing Git state.
2. Keep exact SDK server/client **2.0.0** together and install with the lockfile. Keep Wrangler **4.130.0**, its required Worker tooling, and current peer types for compatibility date **2026-09-08**.
3. Set identity in `.env.example`/deployment config and `wrangler.jsonc`; use one canonical endpoint and exact resource audience. Review Host/Origin hostname allowlists and external-AS configuration. Regenerate Worker types.
4. Customize registrations under `src/shared/{tools,prompts,resources}` and metadata under `src/config/metadata.ts`. Retain complete Zod v4 schemas, request-scoped context, cancellation, and safe structured output.
5. Keep runtime/auth/body/security boundaries in `src/core/*` and `src/http/*`. If injecting a verifier, validate issuer/audience/expiry/scopes independently and never forward the MCP bearer token as a provider credential.
6. Adapt tool-specific assertions in `tests/protocol.test.ts` and `scripts/smoke-client.ts`; retain config and raw-wire regressions. Run every gate above before considering a server-specific rollout.

### Ticket applicability

- **SDK alignment / reusable base:** applicable here; completed to the tested extent above.
- **Native OAuth callback / DCR → authorize → token binding:** **N/A inside `_template`**. This server has no authorization, registration, token, callback, refresh-token, or provider credential-storage endpoints.
- **External AS/Alice integration:** must support a public native client using PKCE S256 and `http://127.0.0.1:{ephemeral-port}/oauth/callback`. For Alice's per-attempt DCR, bind the exact registered URI and returned client ID through authorize and token, with state, a one-use code, PKCE, resource, and scopes. No allow-all callback validation or fixed port. RFC 8252's port-only registration exception is not a token-redemption URI wildcard. See `README.md` and `manual.md` for the external contract.
- Sibling migration policy and provider-specific OAuth designs remain outside this implementation. No sibling server was changed.
