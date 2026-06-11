# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

LumenWipe is a non-custodial web app that closes Stellar accounts: it unwinds everything holding an account open (signers, data entries, offers, trustlines, DeFi positions), converts leftovers to XLM, and merges the account into a destination wallet or exchange. Every transaction is built and signed in the browser; the backend is read-only and can never move funds. Operations are irreversible, so correctness beats speed everywhere in this codebase.

## Commands

Bun (1.3+) is the package manager and unit test runner.

```bash
bun install
bun dev                              # dev server at localhost:3000, testnet by default
bun run build                        # next build
bun lint                             # ESLint, zero errors required
bun format                           # Prettier (authoritative for formatting)
bun type-check                       # tsc for app AND tests/tsconfig.json, strict, zero errors
bun test                             # unit tests (Bun test runner, tests/unit/)
bun test tests/unit/buildPlan.test.ts  # single test file
bun test:e2e                         # Playwright E2E, runs against testnet only
```

All of `bun type-check && bun lint && bun test` must pass before pushing.

Setup: copy `.env.example` to `.env.local`. Minimum config is the `NEXT_PUBLIC_STELLAR_RPC_*` endpoints. `KV_REST_API_*` (Vercel KV) is only needed for the merge stats counter (`lib/kv.ts`).

## Architecture

Three layers with the trust boundary in the browser — private keys never leave the client:

1. **Client** (`app/[network]/`, `components/`, `hooks/`, `store/`): all transaction construction and signing.
2. **Read-only API routes** (`app/api/[network]/`): account analysis, conversion paths, mediator prepare/check. Stateless, no keys, not in the signing path.
3. **External services**: Stellar RPC for live reads/simulation/submission (no Horizon — do not add Horizon dependencies), stellar.expert API for subentry enumeration (`lib/se-api/`), Vercel KV.

Routing splits into two worlds: `app/(marketing)/` is the landing page and MDX blog (`content/blog/`, `lib/blog.ts`) with no transaction logic; `app/[network]/` is the actual tool, where `[network]` is `public` or `testnet` (`config/networks.ts`), with the flow pages `analyze → execute → complete`.

### The demolition pipeline

This is the core of the app and spans several modules:

- **Scan**: `lib/se-api/` enumerates subentries from stellar.expert; `lib/stellar/account.ts` + `lib/stellar/rpc.ts` re-read exact live state over RPC. Never build or sign a transaction from indexer data alone — always re-read on-chain state first.
- **Plan**: a deterministic, ordered list of `PlannedStep` (`types/plan.ts`). Step order is fixed: `NORMALIZE_SIGNERS → REMOVE_DATA_ENTRIES → CANCEL_OFFERS → CLAIM_BALANCES → CONVERT_ASSETS → REMOVE_TRUSTLINES → FUND_MEDIATOR → MERGE`. The same account state must always produce the same plan (covered by `tests/unit/buildPlan.test.ts`).
- **Execute**: `hooks/useStepExecution.ts` drives the loop. Transaction XDR is built lazily per step by `lib/stellar/tx-builder/`, signed in the browser, submitted via `lib/stellar/submit.ts`, and polled to confirmation before advancing.
- **State machine**: `store/demolish.ts` (Zustand) holds the `DemolishPhase` (`IDLE → ANALYZING → PREFLIGHT_COMPLETE → STEP_EXECUTING ⇄ STEP_FAILED → ... → COMPLETE`). Sessions persist to IndexedDB via `lib/session/` (never keys). `hooks/useSessionRecovery.ts` reconciles a resumed session against on-chain state so completed steps are skipped, never re-executed.
- **Mediator flow**: exchanges don't support `ACCOUNT_MERGE`, so merges to exchange destinations go through a temporary mediator account (`lib/stellar/mediator.ts`, `lib/stellar/mediator-session.ts`, `app/api/[network]/mediator/`). Exchange destinations are validated against `config/exchange-registry.json`, which enforces the memo type — a missing memo for a known exchange must block submission.

### Hard invariants

- `lib/stellar/tx-builder/` is a **pure module**: account state in, unsigned transaction envelopes out, zero network side effects. This is what makes it unit-testable and auditable. Keep it that way.
- Automated tests never touch mainnet. E2E runs against testnet.
- A position or step that cannot be closed safely surfaces as a blocker with an explanation — never silently skipped.
- User-facing errors are plain language; never expose raw SDK error codes or stack traces in the UI.
- Changes to key handling, transaction construction, confirmation flows, the mediator flow, or CSP are security-sensitive and get closer review — flag them explicitly in PRs.

## Conventions

See CONTRIBUTING.md for the full rules. The essentials:

- Conventional Commits; types include `security` for hardening changes. Scopes: `builder`, `mediator`, `registry`, `ui`, `backend`, protocol names (`blend`, `soroswap`, ...). Branches: `<type>/<short-description>`.
- Strict TypeScript, no `any` (use `unknown` + type guard); explicit return types on exported functions. Prettier config: double quotes, semicolons, printWidth 100.
- Comments only when the *why* is non-obvious; never describe what the code does.
- Bug fixes require a unit test reproducing the bug. New protocol adapters require testnet integration tests and must satisfy the exit adapter invariants in `docs/architecture.md` §9.9.

`docs/` is both the deep design documentation and the Mintlify site source (docs.lumenwipe.com); `docs/architecture.md` is the authoritative system design, including the security model (§13).

## Project skills

Skills live canonically in `.agents/skills/` with symlinks in `.claude/skills/`, managed by the [skills CLI](https://github.com/vercel-labs/skills) and pinned in `skills-lock.json`. Manage with `npx skills list` / `npx skills update -p` / `npx skills add <repo> -s <skill> -a claude-code -a cursor -y`.

- `dapp`, `data`, `assets` (stellar/stellar-dev-skill) — wallet integration, RPC queries, classic assets/trustlines/SAC.
- `soroswap-sdk` (soroswap/sdk) — use when working on asset conversion via the Soroswap API/SDK; the `CONVERT_ASSETS` step routes through the Soroswap Aggregator per `docs/architecture.md`. Not in the lockfile: the upstream repo doesn't follow the `SKILL.md` convention, so update it manually from `https://raw.githubusercontent.com/soroswap/sdk/main/soroswap-sdk-skill.md`.
- `vercel-react-best-practices` (vercel-labs/agent-skills) — React 19 / Next.js performance rules.
- `webapp-testing` (anthropics/skills) — Playwright-driven browser verification of the guided flow.
