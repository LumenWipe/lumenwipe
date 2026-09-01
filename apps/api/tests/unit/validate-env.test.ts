import { test, expect } from "bun:test";
import { checkEnv, formatEnvFailure } from "@/config/validate-env";

// A service that boots without its configuration and fails per-request is worse than one that
// refuses to start: the deploy goes green, the instance looks healthy, and users meet the
// problem one at a time.

const OK = {
  API_KEYS: "ci=abc123",
  MEDIATOR_SECRET_TESTNET: "S...",
  MEDIATOR_SECRET_MAINNET: "S...",
  OCTOPOS_API_KEY: "oct_abc123",
};

test("a complete environment has no problems and no warnings", () => {
  const { problems, warnings } = checkEnv(OK as NodeJS.ProcessEnv);
  expect(problems).toEqual([]);
  expect(warnings).toEqual([]);
});

test("a missing API_KEYS is fatal", () => {
  const { problems } = checkEnv({} as NodeJS.ProcessEnv);
  expect(problems.map((p) => p.variable)).toContain("API_KEYS");
});

test("an empty API_KEYS is fatal, not an intentional lockout", () => {
  // `API_KEYS=""` in a deploy config is a mistake. Treating it as "reject everything on
  // purpose" would leave the service running and useless.
  const { problems } = checkEnv({ API_KEYS: "   " } as NodeJS.ProcessEnv);
  expect(problems).toHaveLength(1);
});

test("an API_KEYS with no `=` is fatal", () => {
  // The format is `label=key`. A bare value yields no usable key and the client sees a plain
  // 401, with nothing pointing at the server side being malformed - a failure this repo has
  // already paid for once.
  const { problems } = checkEnv({ API_KEYS: "justakey" } as NodeJS.ProcessEnv);
  expect(problems[0]!.message).toMatch(/label=key/);
});

test("a missing mediator secret warns rather than blocking the boot", () => {
  // It disables a path, not the service. Refusing to start over the mainnet secret would take
  // testnet down with it - and mainnet exchange closes are deliberately not enabled yet.
  const { problems, warnings } = checkEnv({
    API_KEYS: "ci=abc",
    OCTOPOS_API_KEY: "oct_abc123",
  } as NodeJS.ProcessEnv);
  expect(problems).toEqual([]);
  expect(warnings.map((w) => w.variable).sort()).toEqual([
    "MEDIATOR_SECRET_MAINNET",
    "MEDIATOR_SECRET_TESTNET",
  ]);
});

test("a missing OCTOPOS_API_KEY warns rather than blocking the boot", () => {
  // Disables the authenticated rate-limit tier, not DeFi detection outright: OctoPos's
  // positions endpoints are reachable unauthenticated at the free tier (architecture.md §7.1).
  const { problems, warnings } = checkEnv({
    API_KEYS: "ci=abc",
    MEDIATOR_SECRET_TESTNET: "S...",
    MEDIATOR_SECRET_MAINNET: "S...",
  } as NodeJS.ProcessEnv);
  expect(problems).toEqual([]);
  expect(warnings.map((w) => w.variable)).toEqual(["OCTOPOS_API_KEY"]);
});

test("the failure message names the variable and where to look", () => {
  const { problems } = checkEnv({} as NodeJS.ProcessEnv);
  const msg = formatEnvFailure(problems);
  expect(msg).toContain("API_KEYS");
  expect(msg).toContain(".env.example");
});

test("an API_KEYS with an empty label or key is fatal", () => {
  // A substring check for "=" passed all of these, and each yields zero usable keys - so the
  // process booted green and every authenticated route 401'd, which is the exact state the
  // check exists to prevent. Counted with the same rule ApiKeyService parses by.
  for (const value of ["=abc123", "label=", " = ", "label=,other="]) {
    const { problems } = checkEnv({ API_KEYS: value } as NodeJS.ProcessEnv);
    expect(problems.map((p) => p.variable)).toContain("API_KEYS");
  }
});

test("a key containing '=' is accepted - base64 padding is not malformed", () => {
  // indexOf, not split: the key is everything after the FIRST "=".
  const { problems } = checkEnv({ API_KEYS: "label=abc==" } as NodeJS.ProcessEnv);
  expect(problems).toEqual([]);
});

test("several comma-separated pairs are accepted", () => {
  const { problems } = checkEnv({ API_KEYS: "a=1,b=2" } as NodeJS.ProcessEnv);
  expect(problems).toEqual([]);
});
