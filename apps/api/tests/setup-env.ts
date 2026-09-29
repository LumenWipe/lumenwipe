// `test:integration`'s own `--preload ./tests/setup-env.ts` runs this before any test file's
// module graph, so config/networks.ts's top-level `process.env` reads always see
// `.env.local`/`.env` regardless of which test file Bun happens to evaluate first. Scoped to
// `test:integration` alone (not a project-wide bunfig.toml preload) - the plain `test` script
// intentionally runs without real dotenv values loaded, and networks-env-rename.test.ts asserts
// exactly that. A single file importing "@/env" as its own first line (the existing convention
// in a few integration tests) only protects that one file: in a real `bun test tests/integration`
// run across many files, whichever file's import graph reaches config/networks.ts first wins for
// the whole process, and once cached, re-importing does not re-run it. Confirmed the hard way:
// sponsorship.integration.test.ts and multisig-close.integration.test.ts passed every time they
// ran alone, but failed with "PATH_ROUTING_API_TESTNET is not configured" the first time they ran
// alongside the rest of tests/integration/, because an alphabetically earlier file without the
// same import had already forced config/networks.ts to evaluate with .env.local not yet loaded.
import "@/env";
