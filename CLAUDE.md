# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

LumenWipe closes Stellar accounts non-custodially: it unwinds everything holding an account open (signers, data entries, offers, trustlines, DeFi positions), converts leftovers to XLM, and merges the account into a destination wallet or exchange. Operations are irreversible, so correctness beats speed everywhere.

The architecture is **API-first and single-channel**. The NestJS **API** is the product: it reads on-chain state and builds every unsigned transaction. The browser only **verifies, signs, and orchestrates** - it holds no transaction-building logic, and the private key never leaves the client. Reads and transaction-building always go through the API.

## Repository layout

Bun-workspaces monorepo. One pinned `@stellar/stellar-sdk` (16.0.1) via root `overrides`, used **server-side only**.

- `apps/api` - NestJS service, the product. Controllers under `src/{account,close,mediator,health}`. Builds the minimal unsigned transaction set, co-signs the mediator forward payment, submits. Stateless across a multi-round close.
- `apps/web` - Next.js thin client. Fetches unsigned XDR, verifies it, signs, submits - all through a server-side proxy. No closing logic.
- `apps/playground` - isolated testnet demo. Custodial (a throwaway demo account, no real user), server-side only, own deploy target (`playground.lumenwipe.com`). Never imported by `apps/web` or `apps/api`, and never imports their closing modules either - it mess-builds junk trustlines/offers/data entries directly with `@stellar/stellar-sdk`, then demolishes through the real `apps/api` via `@lumenwipe/sdk`'s `runClose`, using its own dedicated, independently-rate-limited API key and its own Vercel KV store. It is a separate app rather than a route inside `apps/web` because its trust model is the inverse of production's: the playground holds a private key server-side on the user's behalf, which `apps/web` must never do. Keeping them apart means an audit can scope to a path the same way it would to a separate repo, and no custodial code can ever be one bad import away from the production signing flow - without paying the operational cost of a second repository.
- `packages/sdk` (`@lumenwipe/sdk`) - thin fetch client over the API (tsup ESM+CJS, **does not bundle the Stellar SDK**).
- `packages/types` (`@lumenwipe/types`) - request/response types shared by API, SDK, and web.

## Commands

Bun 1.3+ is the package manager and unit-test runner. Run from the repo root:

```bash
bun install
bun dev                                   # web dev server (localhost:3000, testnet); needs the API running too
bun run dev:api                           # API dev server (nest start --watch)
bun run dev:playground                    # playground dev server (localhost:3002, testnet); needs the API running too
bun run lint | type-check | test          # ALL packages, as a matrix (bun run --filter '*' ...)
bun run build:web | build:api
bun run format                            # Prettier (authoritative for formatting)
```

Target one package with `--filter`:

```bash
bun run --filter '@lumenwipe/web' type-check     # tsc for app AND tests/tsconfig.json
bun run --filter '@lumenwipe/api' test           # bun test tests
bun run --filter '@lumenwipe/web' test:e2e       # Playwright, testnet only
```

Single unit test - run from inside the package (bare `bun test` at root/`apps/web` also picks up the Playwright spec and fails; the `test` scripts scope the path):

```bash
cd apps/web && bun test tests/unit/verify.test.ts
cd apps/api && bun test tests/close-transactions.test.ts
```

`bun type-check && bun lint && bun test` must pass before pushing. Run `bun run format` before opening a PR - CI's `format` job runs `bun run format:check` (`prettier --check .`) and fails the build on any drift, so an unformatted file blocks the PR the same way a failing test does. CI (`.github/workflows/ci.yml`) runs every package's checks on each change as a matrix - a shared `packages/types` change is validated against every consumer, not skipped by a path filter. `deploy-api.yml` deploys the API to Cloud Run on push to `main` (keyless WIF).

### Local full-flow dev

The full close needs **both** services. The web reaches the API only through its own proxy, so:

- `apps/api/.env.local` needs `API_KEYS` (label=key) and the read endpoints (RPC / Horizon-compatible `PATH_ROUTING` / mediator secret for exchange closes). All gitignored.
- `apps/web/.env.local` needs `LUMENWIPE_API_URL` (`http://localhost:3001` locally; production is `https://api.lumenwipe.com`) + `LUMENWIPE_API_KEY` (server-side, injected by the proxy), plus `NEXT_PUBLIC_MEDIATOR_PUBLIC_*` so `verify()` can recognize the mediator (see below).
- `apps/playground/.env.local` (only when working on the playground - a third service, `bun run dev:playground`) needs its own `LUMENWIPE_API_URL` + `LUMENWIPE_API_KEY` under a distinct `API_KEYS` label, `PLAYGROUND_ENCRYPTION_KEY`, the testnet issuer/market-maker secrets, and its own KV credentials - never `apps/web`'s. See `apps/playground/.env.example`.

## Architecture

### The trust boundary moved to `verify()`

The API builds the bytes; the browser decides whether to sign them. `apps/web/lib/stellar/verify.ts` (`verifyCloseTransaction` / the pure `assertCloseIntent`) is the **trust anchor**: before signing, it decodes the API-built XDR and asserts it does exactly what the user asked - merge only to the stated destination or the shared mediator, payments only return-to-issuer, the mediator forward, or a transfer matching the user's own asset/destination/amount choice - and always sourced from the account being closed, conversions to self/native with a positive destination minimum, only removals of trustlines/data/offers, `SetOptions` that never adds a signer or raises thresholds, matching memo, no unknown operation. Its expected values come from the **user's own inputs, never the API response**, so a compromised API cannot get funds diverted. A mismatch aborts before signing.

**Consequence for any new close operation** (e.g. a sponsorship-revoke or a new claiming step): add it in **two** places - the API's transaction builder **and** `verify()`'s allowlist - or the anchor rejects the transaction as an unknown op.

### The close loop

`analyze → POST close/plan → review gate → POST close/transactions (per round) → verify → sign → POST submit → repeat until done`. Between the plan being finalized and the first transaction ever being fetched sits a client-side, user-visible checkpoint: `DemolishPhase` moves to `PREFLIGHT_COMPLETE` and the user lands on `/review`, seeing the whole plan before anything is built or signed. Only that page's own confirmation advances the phase to `STEP_EXECUTING` and navigates to `/execute`; nothing is persisted to a resumable session until that confirmation fires, so closing the tab while still on `/review` leaves no record to resume. (`SIGNER_SETUP` remains declared but unused/reserved.) The API itself is stateless: each round it re-reads live state and re-derives the remaining work (`remaining.requiresAnotherCall`), so an interrupted close resumes by simply calling again - there is no per-step server progress to reconcile. Driven client-side by `runClose` (`@lumenwipe/sdk`, pure, dependency-injected runner) via `hooks/useCloseExecution.ts`.

There is no "fast path" or "fused" mode: producing the minimal set of transactions is just how a close works. Most accounts are one transaction; an exchange adds the mediator transfer; claimable balances, a Soroswap-aggregator swap, or >100 operations force additional transactions.

### The proxy (no key in the browser)

`apps/web/app/api/**/route.ts` are thin server-side proxies: each injects the API key via `getApiClient()` and forwards to the NestJS API, with per-IP rate limiting and short-TTL caching. The browser never holds an API key. A `no-restricted-imports` boundary lint in `apps/web/.eslintrc.json` (no exemptions) forbids the web from importing any closing/tx-building module or `@lumenwipe/api`, so the thin-client boundary can't erode.

### Mediator flow (exchanges)

Exchanges don't accept `ACCOUNT_MERGE`. The user merges into a shared, persistent mediator account, and the API co-signs the mediator's forward payment to the exchange (mediator secret `MEDIATOR_SECRET_*` lives server-side). The web needs no knowledge of which account the mediator is. `verify()` accepts the merge on **structure**: exactly two operations, the merge sourced from the account being closed, and a forward **sent by the account the merge just paid into**, to the address the user typed, in XLM, for at least the balance the client observed. That makes the mediator a conduit rather than a destination, so it rotates without touching any client - and it is stronger than pinning an address, which proved identity but never that the balance moved on.

## Conventions

CONTRIBUTING.md has the full rules. Essentials:

- Conventional Commits; `security` type for hardening. Scopes: `builder`, `mediator`, `registry`, `ui`, `backend`, `web`, protocol names. Branches `<type>/<short-description>`.
- Strict TypeScript, no `any` (use `unknown` + a guard); explicit return types on exported functions. Prettier: double quotes, semicolons, printWidth 100.
- Comments only when the _why_ is non-obvious.
- Bug fixes require a unit test reproducing the bug. Automated tests never touch mainnet; E2E runs on testnet.
- Test fixtures never use a real, checksum-valid secret key (Stellar or otherwise) - a synthetic, non-strkey placeholder only, even when a test's plaintext coincidentally looks like key material. A leaked test fixture is exactly as dangerous as a leaked production secret regardless of which network it was ever funded on.
- Security-sensitive changes - key handling, transaction construction, `verify()`, confirmation flows, the mediator flow, CSP - get closer review; flag them explicitly in PRs.
- Security-sensitive changes (the same list above) require running `security-review` before opening the PR; note the result in the PR description.

## Hard invariants

- The API's transaction builder is a **pure module** (state in, unsigned envelopes out, no network side effects) - keep it unit-testable and auditable.
- Never build or sign from indexer data alone: the API re-reads exact on-chain state over RPC immediately before building.
- A position or step that cannot be closed safely surfaces as a blocker with an explanation, never silently skipped.
- User-facing errors are plain language; never surface raw SDK codes or stack traces.

## Gotchas

- **`@stellar/stellar-sdk` v16 dual-build hazard**: never mix `require()` and `import` of the SDK in the same runtime - the CJS and ESM builds each bundle their own `js-xdr`, and objects don't cross the boundary. Keep it server-side (API) only.
- **SDK-from-source resolution**: the web resolves `@lumenwipe/sdk` and `@lumenwipe/types` from TS **source** via tsconfig `paths` + Next `transpilePackages`, so there is no build-order dependency on the packages' `dist` (works in CI, Vercel, and local without a prior package build).
- **API build**: `nest build` does not rewrite `@/*` tsconfig aliases, so the api build script runs `tsc-alias` after it - otherwise `node dist/main.js` fails with `Cannot find module '@/...'` (latent because dev uses `nest start` and tests run from source).
- The **playground** was rebuilt as `apps/playground` (it previously lived inside `apps/web` and built transactions client-side, which is why it was removed). It never builds a close transaction itself: the demolish step goes through the real `apps/api` via `@lumenwipe/sdk`. Its own `lib/verify.ts` is a second, narrower trust anchor over the same operation shapes as `apps/web/lib/stellar/verify.ts` - a new close operation has to be added there too, or the playground rejects it.
- **`.env.local` load order**: `config/networks.ts` reads `process.env` in top-level `const` initializers, which run at import time, before `ConfigModule.forRoot()`'s dotenv side effect (declared in `app.module.ts`) gets a chance to run, since `AppModule`'s own imports load first. `apps/api/src/main.ts` works around this with `import "./env"` as its literal first line; keep it first, or vars with no working default (like `PATH_ROUTING_API_URLS`) silently go missing from `.env.local`-only setups.

## Docs

`docs/architecture.md` is the authoritative system design (security model in §13). `docs/` is also the Mintlify site source (docs.lumenwipe.com). Diagram sources live in `diagrams/` at the repo root: `diagrams/generator/*.py` (Graphviz, the source of truth) regenerate the rendered SVG/PNG via `python diagrams/generator/render-all.py`; `diagrams/mmd/*.mmd` are unwired Mermaid copies kept only for quick reference. Rendered output stays at `docs/diagrams/output/` because `docs/architecture.md`, the root `README.md`, and the Mintlify site all reference that path.
