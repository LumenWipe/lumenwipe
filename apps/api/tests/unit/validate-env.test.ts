import { test, expect } from "bun:test";
import { checkEnv, formatEnvFailure } from "@/config/validate-env";

// A service that boots without its configuration and fails per-request is worse than one that
// refuses to start: the deploy goes green, the instance looks healthy, and users meet the
// problem one at a time.

const OK = {
  API_KEYS: "ci=abc123",
  MEDIATOR_SECRET_TESTNET: "S...",
  MEDIATOR_SECRET_MAINNET: "S...",
  FEE_ACCOUNT_SECRET_TESTNET: "S...",
  FEE_ACCOUNT_SECRET_MAINNET: "S...",
  SOROSWAP_API_KEY: "sk_test",
  OCTOPOS_API_KEY: "oct_abc123",
  ADMIN_API_TOKEN: "admin_test_token",
  FIRESTORE_PROJECT_ID: "test-project",
  INTEGRATOR_AUTH_SECRET: "test-integrator-auth-secret-0123456789",
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
    FEE_ACCOUNT_SECRET_TESTNET: "S...",
    FEE_ACCOUNT_SECRET_MAINNET: "S...",
    OCTOPOS_API_KEY: "oct_abc123",
    SOROSWAP_API_KEY: "sk_test",
    ADMIN_API_TOKEN: "admin_test_token",
    FIRESTORE_PROJECT_ID: "test-project",
    INTEGRATOR_AUTH_SECRET: "test-integrator-auth-secret-0123456789",
  } as NodeJS.ProcessEnv);
  expect(problems).toEqual([]);
  expect(warnings.map((w) => w.variable).sort()).toEqual([
    "MEDIATOR_SECRET_MAINNET",
    "MEDIATOR_SECRET_TESTNET",
  ]);
});

test("a missing fee-account secret warns rather than blocking the boot", () => {
  // Same reasoning as the mediator secret: it disables sponsored-fee closes on that network,
  // not the service, and mainnet is deliberately not enabled yet.
  const { problems, warnings } = checkEnv({
    API_KEYS: "ci=abc",
    MEDIATOR_SECRET_TESTNET: "S...",
    MEDIATOR_SECRET_MAINNET: "S...",
    OCTOPOS_API_KEY: "oct_abc123",
    SOROSWAP_API_KEY: "sk_test",
    ADMIN_API_TOKEN: "admin_test_token",
    FIRESTORE_PROJECT_ID: "test-project",
    INTEGRATOR_AUTH_SECRET: "test-integrator-auth-secret-0123456789",
  } as NodeJS.ProcessEnv);
  expect(problems).toEqual([]);
  expect(warnings.map((w) => w.variable).sort()).toEqual([
    "FEE_ACCOUNT_SECRET_MAINNET",
    "FEE_ACCOUNT_SECRET_TESTNET",
  ]);
});

test("a missing OCTOPOS_API_KEY warns rather than blocking the boot", () => {
  // Disables the authenticated rate-limit tier, not DeFi detection outright: OctoPos's
  // positions endpoints are reachable unauthenticated at the free tier (architecture.md §7.1).
  const { problems, warnings } = checkEnv({
    API_KEYS: "ci=abc",
    MEDIATOR_SECRET_TESTNET: "S...",
    MEDIATOR_SECRET_MAINNET: "S...",
    FEE_ACCOUNT_SECRET_TESTNET: "S...",
    FEE_ACCOUNT_SECRET_MAINNET: "S...",
    SOROSWAP_API_KEY: "sk_test",
    ADMIN_API_TOKEN: "admin_test_token",
    FIRESTORE_PROJECT_ID: "test-project",
    INTEGRATOR_AUTH_SECRET: "test-integrator-auth-secret-0123456789",
  } as NodeJS.ProcessEnv);
  expect(problems).toEqual([]);
  expect(warnings.map((w) => w.variable)).toEqual(["OCTOPOS_API_KEY"]);
});

test("a missing ADMIN_API_TOKEN, FIRESTORE_PROJECT_ID or INTEGRATOR_AUTH_SECRET warns rather than blocking the boot", () => {
  // Disables self-serve API key management (issue #289), not the service.
  const base = {
    API_KEYS: "ci=abc",
    MEDIATOR_SECRET_TESTNET: "S...",
    MEDIATOR_SECRET_MAINNET: "S...",
    FEE_ACCOUNT_SECRET_TESTNET: "S...",
    FEE_ACCOUNT_SECRET_MAINNET: "S...",
    OCTOPOS_API_KEY: "oct_abc123",
    SOROSWAP_API_KEY: "sk_test",
  };
  const { problems, warnings } = checkEnv(base as NodeJS.ProcessEnv);
  expect(problems).toEqual([]);
  expect(warnings.map((w) => w.variable).sort()).toEqual([
    "ADMIN_API_TOKEN",
    "FIRESTORE_PROJECT_ID",
    "INTEGRATOR_AUTH_SECRET",
  ]);
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

const MAINNET_SET = {
  STELLAR_RPC_MAINNET: "https://rpc.test",
  PATH_ROUTING_API_MAINNET: "https://h.test",
};

function endpointCheck(env: Record<string, string>) {
  return checkEnv({ ...OK, ...env } as NodeJS.ProcessEnv);
}

test("in production an unset mainnet endpoint warns and boots", () => {
  const { problems, warnings } = endpointCheck({ NODE_ENV: "production" });
  expect(problems).toEqual([]);
  expect(warnings.map((w) => w.variable)).toEqual([
    "STELLAR_RPC_MAINNET",
    "PATH_ROUTING_API_MAINNET",
  ]);
});

test("outside production an unset mainnet endpoint is not worth a warning", () => {
  expect(endpointCheck({ NODE_ENV: "development" }).warnings).toEqual([]);
});

test("REQUIRE_EXPLICIT_MAINNET_ENDPOINTS=true refuses an unset mainnet endpoint, naming it", () => {
  const { problems, warnings } = endpointCheck({
    NODE_ENV: "production",
    REQUIRE_EXPLICIT_MAINNET_ENDPOINTS: "true",
    PATH_ROUTING_API_MAINNET: "https://h.test",
  });
  expect(warnings).toEqual([]);
  expect(problems.map((p) => p.variable)).toEqual(["STELLAR_RPC_MAINNET"]);
  expect(formatEnvFailure(problems)).toContain("REQUIRE_EXPLICIT_MAINNET_ENDPOINTS=true");
});

test("only the literal true turns the refusal on", () => {
  const { problems } = endpointCheck({ REQUIRE_EXPLICIT_MAINNET_ENDPOINTS: "false" });
  expect(problems).toEqual([]);
});

test("a legacy name counts as explicit, and an empty new name overrides it", () => {
  const strict = { NODE_ENV: "production", REQUIRE_EXPLICIT_MAINNET_ENDPOINTS: "true" };
  const legacy = {
    NEXT_PUBLIC_STELLAR_RPC_MAINNET: "https://rpc.test",
    NEXT_PUBLIC_PATH_ROUTING_API_MAINNET: "https://h.test",
  };
  expect(endpointCheck({ ...strict, ...legacy }).problems).toEqual([]);
  const cleared = endpointCheck({ ...strict, ...legacy, STELLAR_RPC_MAINNET: "" });
  expect(cleared.problems.map((p) => p.variable)).toEqual(["STELLAR_RPC_MAINNET"]);
});

test("an unset testnet endpoint is never a finding", () => {
  const { problems, warnings } = endpointCheck({
    ...MAINNET_SET,
    NODE_ENV: "production",
    REQUIRE_EXPLICIT_MAINNET_ENDPOINTS: "true",
  });
  expect(problems).toEqual([]);
  expect(warnings).toEqual([]);
});

test("a lone URL is not held to the list rules", () => {
  const { problems } = endpointCheck({
    STELLAR_RPC_TESTNET: "http://localhost:8000",
    STELLAR_RPC_HEADER_NAME_TESTNET: "x-key",
  });
  expect(problems).toEqual([]);
});

test("a list refuses a non-https entry, naming its position and not its value", () => {
  const { problems } = endpointCheck({
    STELLAR_RPC_TESTNET: "https://a.test,http://b.test/secret-path",
  });
  expect(problems.map((p) => p.message)).toEqual(["STELLAR_RPC_TESTNET entry 2 must use https."]);
});

test("a list refuses an entry that is not a URL", () => {
  const { problems } = endpointCheck({ PATH_ROUTING_API_TESTNET: "https://a.test,nonsense" });
  expect(problems.map((p) => p.message)).toEqual([
    "PATH_ROUTING_API_TESTNET entry 2 is not a valid URL.",
  ]);
});

test("a list refuses a duplicate, however the same URL is spelled", () => {
  const { problems } = endpointCheck({
    STELLAR_RPC_TESTNET: "https://A.test/rpc/, https://a.test/rpc",
  });
  expect(problems.map((p) => p.message)).toEqual([
    "STELLAR_RPC_TESTNET entry 2 duplicates an earlier entry.",
  ]);
});

test("two paths on one host are two providers", () => {
  const { problems } = endpointCheck({ STELLAR_RPC_TESTNET: "https://a.test/x,https://a.test/y" });
  expect(problems).toEqual([]);
});

test("a list refuses a header name without its value at any position", () => {
  const { problems } = endpointCheck({
    STELLAR_RPC_TESTNET: "https://a.test,https://b.test",
    STELLAR_RPC_HEADER_NAME_TESTNET_2: "x-key",
  });
  expect(problems.map((p) => p.message)).toEqual([
    "STELLAR_RPC_TESTNET entry 2 needs both STELLAR_RPC_HEADER_NAME_TESTNET_2 and " +
      "STELLAR_RPC_HEADER_VALUE_TESTNET_2, or neither.",
  ]);
});

test("a list's first position may pair a legacy header name with a legacy value", () => {
  const { problems } = endpointCheck({
    STELLAR_RPC_TESTNET: "https://a.test,https://b.test",
    NEXT_PUBLIC_STELLAR_RPC_HEADER_NAME_TESTNET: "x-key",
    NEXT_PUBLIC_STELLAR_RPC_HEADER_VALUE_TESTNET: "synthetic",
  });
  expect(problems).toEqual([]);
});
