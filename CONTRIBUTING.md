# Contributing to LumenWipe

Thank you for your interest in contributing. LumenWipe performs irreversible operations on real Stellar accounts, so correctness and security matter more than speed. This guide explains how to contribute effectively and safely.

---

## Table of contents

1. [What we welcome](#1-what-we-welcome)
2. [Before you start](#2-before-you-start)
3. [Development setup](#3-development-setup)
4. [Code conventions](#4-code-conventions)
5. [Commit messages](#5-commit-messages)
6. [Branch naming](#6-branch-naming)
7. [Pull request process](#7-pull-request-process)
8. [Testing requirements](#8-testing-requirements)
9. [Contributing to registries](#9-contributing-to-registries)
10. [Reporting bugs](#10-reporting-bugs)
11. [Security issues](#11-security-issues)

---

## 1. What we welcome

| Contribution type          | Notes                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Bug fixes                  | Include a test that reproduces the bug before the fix                                                         |
| New DeFi protocol support  | Follow the [add a protocol exit guide](docs/contributing/add-a-protocol-exit.mdx), which links the invariants |
| Exchange registry entries  | See [Contributing to registries](#9-contributing-to-registries)                                               |
| Contract registry updates  | New `wasmHash` → protocol version mappings for supported protocols                                            |
| Documentation improvements | Fix errors, improve clarity, add missing details                                                              |
| Test coverage              | Unit tests for the transaction builder and edge cases are especially valuable                                 |
| UI improvements            | Stick to the existing component patterns; changes to confirmation flows require extra care                    |
| Translations               | Open an issue first to coordinate                                                                             |

If you are planning a large change - a new protocol integration, a significant refactor, a new feature - **open an issue first** to discuss the approach before writing code. This avoids effort going in a direction that won't be merged.

---

## 2. Before you start

- Read the [technical architecture](docs/architecture.md) to understand how the system is designed and why.
- For protocol integrations, follow the [add a protocol exit guide](docs/contributing/add-a-protocol-exit.mdx), which lists every file an exit touches, and read [Section 9](docs/architecture.md#9-closing-positions-classic-and-soroban-defi) and [Section 9.9](docs/architecture.md#99-exit-adapter-invariants) carefully. Every exit adapter must satisfy the invariants listed there.
- For security-sensitive changes (key handling, transaction construction, confirmation flows, the mediator flow), read [Section 13](docs/architecture.md#13-security-model) before touching that code.

---

## 3. Development setup

**Requirements:** [Bun](https://bun.sh) 1.4.4 (the version in `packageManager`), Node.js 22.12 or later

```bash
# Fork and clone the repository
git clone https://github.com/LumenWipe/lumenwipe.git
cd lumenwipe

# Install dependencies
bun install

# Copy each app's environment file and configure it
cp apps/api/.env.example apps/api/.env.local
cp apps/web/.env.example apps/web/.env.local
# In apps/api/.env.local set at least STELLAR_RPC_TESTNET and API_KEYS;
# in apps/web/.env.local set LUMENWIPE_API_KEY to one of those keys

# Start the API (port 3001) and the web app (port 3000), in two terminals
bun run dev:api
bun dev
```

Open [http://localhost:3000](http://localhost:3000). The app defaults to Stellar testnet - no real funds are at risk during development.

**Verify the setup:**

```bash
bun type-check   # TypeScript - must pass with zero errors
bun lint         # ESLint - must pass with zero errors
bun test         # Unit tests - must all pass
```

---

## 4. Code conventions

### TypeScript

- Strict mode is on. All code must type-check with zero errors (`bun type-check`).
- Avoid `any`. Use `unknown` with a type guard, or model the type properly.
- Prefer explicit return types on exported functions.

### Formatting

[Prettier](https://prettier.io) is authoritative. Run `bun format` before committing. The project config (`.prettierrc`):

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "es5",
  "printWidth": 100,
  "tabWidth": 2
}
```

### User-facing vocabulary

User-facing text in `apps/web` follows the glossary in `apps/web/lib/glossary.ts`: the act is "close", the shared exchange account is the "relay account", and "wind-down", "demolish", "wipe", "mediator" and "intermediary" must not appear in strings or JSX text. Code, docs and the API keep "mediator". `apps/web/tests/unit/user-facing-copy.test.ts` enforces this on `app/` and `components/`.

### Comments

Write comments only when the **why** is non-obvious - a hidden constraint, a subtle invariant, a workaround for a specific protocol behavior. Do not describe what the code does; well-named identifiers do that.

### Error handling

- Validate at system boundaries (user input, external APIs). Trust internal code and SDK guarantees.
- Every error surfaced to the user must be in plain language. Never expose raw SDK error codes or stack traces to the UI.
- A position or step the tool cannot safely close must surface as a blocker with an explanation, never be silently skipped.

### Transaction builder

The transaction builder (`apps/api/src/lib/stellar/tx-builder/`) is a pure module: account state in, unsigned transaction envelopes out, no network side effects. Keep it that way - it makes it directly unit-testable and auditable.

---

## 5. Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org):

```
<type>(<scope>): <short summary>

[optional body]

[optional footer]
```

**Types:**

| Type       | When to use                                                               |
| ---------- | ------------------------------------------------------------------------- |
| `feat`     | New functionality                                                         |
| `fix`      | Bug fix                                                                   |
| `test`     | Adding or improving tests                                                 |
| `docs`     | Documentation only                                                        |
| `refactor` | Code change that neither fixes a bug nor adds a feature                   |
| `chore`    | Dependency updates, tooling, config                                       |
| `security` | Security fix or hardening (use for key handling, CSP, validation changes) |

**Scopes** (optional, use when it helps): `builder`, `mediator`, `blend`, `aquarius`, `soroswap`, `phoenix`, `fxdao`, `registry`, `api`, `web`, `ui`, `backend`, `tests`, `deps`

A protocol name is the scope for that protocol's exit adapter and its tests. `xbull` is not a scope: xBull is a swap router used for token conversion, with no exit of its own, so a change to it uses `api`, `registry` or `web`.

**Examples:**

```
feat(blend): add V2 pool exit via blend-sdk Pool.submit
fix(mediator): require memo for known exchange destinations before submission
test(builder): add edge case for account with 1000 subentries
security(key-handling): wipe the secret key on Forget key and on leaving the flow
chore(registry): add Binance deposit address to exchange registry
```

Keep the summary under 72 characters. Use the body to explain the _why_ if it is not obvious from the diff.

---

## 6. Branch naming

```
<type>/<short-description>
```

Examples:

```
feat/phoenix-lp-exit
fix/mediator-memo-validation
test/blend-undercollateralized-vault
docs/architecture-soroban-section
chore/registry-kraken-address
```

---

## 7. Pull request process

1. **Open an issue first** for anything beyond a small fix or registry update.
2. **Fork** the repository and work on a branch, not directly on `main`.
3. **Keep PRs focused.** One logical change per PR. A PR that adds a new protocol exit should not also refactor unrelated code.
4. **Write tests.** New protocol adapters require integration tests against testnet. Bug fixes require a unit test reproducing the bug. See [Testing requirements](#8-testing-requirements).
5. **Pass all checks locally** before pushing:
   ```bash
   bun type-check && bun lint && bun test
   ```
6. **Fill in the PR description** completely:
   - What the change does and why
   - How it was tested
   - Any risk or edge cases the reviewer should pay attention to
   - For protocol changes: which invariants in [Section 9.9](docs/architecture.md#99-exit-adapter-invariants) are satisfied and how
7. **Security-sensitive changes** (key handling, transaction construction, confirmation flows, mediator flow, CSP) require extra description and will receive closer review. Flag them explicitly. The [security scope](docs/security-scope.md) lists the paths this covers, the owner role of each, and the closer-review rule those changes follow. A new close operation, signing key, adapter, surface or app boundary also updates the [threat model](docs/threat-model.md) and its row in the [invariant register](docs/invariants.mdx); run `bun run check:docs`, which CI runs on every pull request, to confirm every file, symbol and test it names still exists.
8. A maintainer will review your PR. Be prepared for back-and-forth - the review is thorough because the operations are irreversible.
9. Squash commits if requested before merge.

---

## 8. Testing requirements

The test suite has two tiers. Automated tests **never touch mainnet**.

### Unit tests (`tests/unit/`)

Run with `bun test`. Test pure logic with deterministic fixtures: transaction construction, fee estimation, reserve math, routing parameter derivation, state machine transitions, input validation, batching. The transaction builder (`apps/api/src/lib/stellar/tx-builder/`) is the highest-coverage module and new logic there must be unit-tested.

```bash
bun test              # run all unit tests
bun test:watch        # watch mode during development
```

### End-to-end tests (`tests/e2e/`)

Playwright drives a real browser against **testnet** through full flows: account analysis, each step category, the mediator flow, session recovery. New protocol integrations require a matching E2E test that executes the full exit against a testnet account with a real position.

```bash
bun run --filter '@lumenwipe/web' test:e2e
```

Playwright starts both the API and the web app itself, so no second terminal is needed - but both still read their own `.env.local`, which is gitignored and therefore absent from a fresh clone (see [Development setup](#3-development-setup)). Without `API_KEYS` on the API and `LUMENWIPE_API_URL` / `LUMENWIPE_API_KEY` on the web, every proxied call is rejected and the whole suite fails at the first analyze.

**When it runs, and who looks.** These specs hit live testnet and take ten-plus minutes, so they are deliberately not part of the per-PR checks. The only Playwright run on a PR is the accessibility gate below, which never touches testnet. They run on a schedule instead, at 07:00 UTC daily (`.github/workflows/e2e-nightly.yml`), and can be triggered by hand from the Actions tab. **A failing night opens a GitHub issue assigned to the maintainer (@miguelnietoa), and the next green run - including a manual one - closes it.** That is the mechanism, and the assignment is the point: a red run in the Actions tab is the same as no signal at all if nobody is looking, and so is an unassigned issue in the backlog. It is exactly how five specs stayed broken for days after a UI change (#95, #119).

Three consequences worth knowing:

- **A UI change can break these without any check going red on your PR.** If you move or rename something the flows drive - the account-address field, the risk notice, a button label - update `tests/e2e/helpers/` in the same change. The shared steps live there so it is one edit rather than one per spec.
- **A nightly failure means the irreversible close path is unverified until it is fixed.** Testnet is occasionally flaky, so download the `playwright-report` artifact from the run before concluding the tests are simply wrong.
- **Green does not always mean "everything ran".** Three specs call `test.skip()` when live testnet has no USDC liquidity or no strict-send route, and a skip does not fail the job. The report artifact is uploaded on every run, not just failures, so the skip count is there when a result looks suspiciously easy.

### Accessibility gate (`tests/e2e/a11y/`)

Every PR runs axe through Playwright on the home, entry, analyze, review, execute and complete screens, the allowance inspector, the history panel, and the error and not-found pages, at 360, 768 and 1280 px wide. It also checks that Tab reaches every control on the entry and analyze screens and that each one shows the focus ring. The CI job is `web accessibility (axe)`, and it feeds the required `type-check · lint · test` check.

```bash
bun run --filter '@lumenwipe/web' test:a11y
```

- **Ruleset.** WCAG 2.2 A and AA (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`). A serious or critical violation fails the run. Moderate and minor findings are attached to the test report as annotations.
- **No network.** `tests/e2e/a11y/fixtures.ts` answers every `/api/**` call in the browser, so only the web is started, from its production build. The close flow signs a fixture merge with a `Keypair.random()` key and hands it to a stand-in submit, so nothing is sent. A call no fixture answers fails the test, so a new endpoint needs a fixture in the same change.
- **Reduced motion.** The specs run with `prefers-reduced-motion: reduce`, so axe reads each element in its final state rather than halfway through a fade.
- **Suppressions.** Disabling a rule or excluding a node needs an inline comment with the reason and a link to an open issue, and the PR description lists it. There are none today.

The playground has the same gate in `apps/playground/tests/e2e/a11y/`, run by the `playground accessibility (axe)` job at 320, 360 and 1280 px: the start screen, a set-up demo with its live state and revealed key, a refused key request, the countdown's warning and end, a setup step refused for time, a finished demo, and the scene's list view. It also checks the scene's keyboard model, that the orbit stands still under reduced motion and stops with its pause button, and that at 320 px nothing scrolls sideways, the controls come before the scene and every node fits inside it. Its fixtures answer every playground route in the browser against the production build, so nothing is funded or sent, and a route no fixture answers fails the test. The nightly testnet suite skips this folder.

```bash
bun run --filter '@lumenwipe/playground' test:a11y
```

### What to test for a new protocol exit

At minimum:

- Normal exit: position detected, exit transaction built, simulated, and submitted correctly on testnet
- No position: adapter returns no steps when the account has no position in this protocol
- Unknown `wasmHash`: adapter flags the position for manual review instead of building an exit
- Clamp to balance: exit does not over-withdraw (amount larger than position is clamped)
- Repay before withdraw (for lending protocols): debt is repaid before collateral is touched

### Integration tests (`tests/integration/`)

Run with `bun run test:integration` from `apps/api`. It is not part of `bun test`, but CI
runs it on every PR and every push to `main`: the read-only tests in the `integration (live RPC)`
job, and the tests that fund testnet accounts in the `integration (funded)` job. For
server-side-only logic with no UI to drive through Playwright (e.g. account-state enumeration),
this is the tier that actually touches testnet, matching the integration tier
docs/architecture.md §17 describes.

---

## 9. Contributing to registries

The exchange registry and contract registry are versioned JSON files. Updates to these are the most common and lowest-risk contribution, and they follow a simple process.

### Exchange registry

Maps known exchange and anchor deposit addresses to whether they need the mediator flow, and what memo type is required.

To add an exchange:

1. Find the exchange's official Stellar deposit address documentation.
2. Determine the memo type they require (`text`, `id`, `hash`, or none).
3. Open a PR that adds the entry to `apps/api/src/config/exchange-registry.json`. There is one registry file: the API loads it and serves it, and the web bundles the same file through the `@registry/*` alias as an offline floor for when the API is unreachable. Include a link to the source documentation in the PR description.
4. Run `bun test tests/unit/exchange-registry-validation.test.ts` from `apps/api` before opening the PR; the suite validates the shipped file, so a malformed edit fails CI.
5. A maintainer will verify the address and merge.

**Testnet-only entries.** An entry may carry `"network": "testnet"`, which makes it invisible on mainnet: no relay routing, no memo rule from the registry, and the address is treated as any other unlisted destination there (the API, the web and `@lumenwipe/verify` all scope their lookups by network). It is allowed only for an account LumenWipe itself controls on testnet to stand in for an exchange, today the playground's exchange scenario, never for a real exchange's address. It must have a neutral name that does not imitate a real exchange, an address generated for the purpose whose public key alone is recorded, `requiresMediator: true` and the memo rule the stand-in enforces. The only value accepted is `"testnet"`: any other value, including `"mainnet"`, refuses the whole file in the API and the web, and an entry without the field applies on every network. Testnet-only entries are left out of the public count on the supported page, and they are not part of the quarterly re-verification against exchange docs.

**Deposit addresses only.** Exchanges also publish withdrawal and cold-storage addresses, and those are deliberately excluded: the registry answers "is this where a user is depositing", and a cold-storage address listed as an exchange would route a close through the mediator for no reason.

**The registry expires, and expiry blocks exchange closes.** The registry carries `lastVerified` and `validUntil`. Past `validUntil`, both sides refuse a close into a listed exchange rather than proceed on rules nobody has checked: the API answers `POST /close/transactions` with `503 registry_expired` (see `docs/runbooks/registry-expiry.mdx`), and the web says why on the destination and plan screens and has `verify()` reject the transaction with `registry_expired` before anything is signed. Closes into any other destination are unaffected. That is deliberate: a wrong memo rule means the funds arrive at a live address and are credited to nobody - the transaction succeeds, there is no error, and the source account is gone.

**Refreshing it is quarterly, bounded, manual work.** Twenty mainnet entries. For each, open the exchange's own deposit documentation and confirm the address and the memo type still match; `https://api.stellar.expert/explorer/public/directory` (which needs a `User-Agent` header, and returns 403 without one) is useful for discovery and for cross-checking the memo-required flag, but it carries no memo _type_, so it cannot replace reading the exchange's docs. Then set `lastVerified` to today and `validUntil` 90 days out, and say in the PR what you checked against.

A mechanism without the process is theatre: the file sat at its original stamp for three months before anything noticed, which is what motivated the expiry in the first place (#81).

### Contract registry

Records the DeFi contracts the tool knows - address, protocol, version, and the `wasmHash` each was verified as running - so detection knows what to probe and exit adapters pick the correct interface. An unknown hash flags the position for manual review and builds nothing, so an entry here is what lets an exit happen at all.

The file is `apps/api/src/config/contract-registry.json`; the field reference and contribution flow live next to its loader in `apps/api/src/lib/contract-registry/README.md`. In short:

1. Fetch the contract's code hash from the ledger yourself (`stellar contract fetch --id C... --network <network> | sha256sum`, or the contract instance over RPC `getLedgerEntries`). Never copy a hash from a forum post or another registry.
2. Add one entry with the network you verified it on, `protocol`, `kind`, `address`, `wasmHash` (64 lowercase hex), `version`, `label`, `verifiedLive`, and ideally `verifiedBy` - the exact command or explorer link from step 1, so a reviewer can re-run it. Resolution is scoped to the entry's network, so only record the one you actually checked.
3. Run `bun test tests/unit/contract-registry.test.ts` from `apps/api`; the suite validates the shipped file, so a malformed edit fails CI.

One entry per PR, with the verification evidence in the description. Like the exchange registry, the file carries `lastVerified` / `validUntil` and is fail-closed past expiry; refreshing it means re-resolving every entry and saying in the PR what you checked. Registry updates go through the same PR review as code changes.

---

## 10. Reporting bugs

Open a [GitHub Issue](https://github.com/LumenWipe/lumenwipe/issues) with:

- A clear description of the unexpected behavior
- Steps to reproduce (network, account type, which step failed)
- What you expected to happen
- What actually happened (error message, transaction hash if applicable)
- Whether this was on testnet or mainnet

**Do not include private keys or seed phrases in bug reports.** If a key was exposed, treat it as compromised and rotate it immediately.

---

## 11. Security issues

**Do not open a public issue for security vulnerabilities.**

Report them privately following the process in [SECURITY.md](SECURITY.md).

### Security tooling report

`bun run security:scan` runs the dependency audit (`bun audit`), Semgrep and gitleaks over the history
reachable from `HEAD`, with the tool versions, rule pack names, flags and targets CI reads from
`scripts/security-tools.json`, and writes `security-reports/YYYY-MM-DD.md` and `.json` with the tool versions,
the commit and the findings by severity. Semgrep's rule packs and the advisory database are fetched live, so two
runs on different days can differ. A finding never fails the script; it fails only when a tool cannot run, so a
report it writes is a complete one. It needs `semgrep` and `gitleaks` at the pinned versions and prints the
install command when either is missing. Reports stay local (`security-reports/` is ignored by git); a refresh
of the [remediation plan](docs/security-remediation-plan.md) carries the counts, findings and decisions.
