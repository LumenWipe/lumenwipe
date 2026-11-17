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
  STELLARINDEX_API_KEY: "sip_test",
  ADMIN_API_TOKEN: "admin_test_token",
  FIRESTORE_PROJECT_ID: "test-project",
  INTEGRATOR_AUTH_SECRET: "test-integrator-auth-secret-0123456789",
};

test("a complete environment has no problems and no warnings", () => {
  const { problems, warnings } = checkEnv(OK);
  expect(problems).toEqual([]);
  expect(warnings).toEqual([]);
});

test("a missing API_KEYS is fatal", () => {
  const { problems } = checkEnv({});
  expect(problems.map((p) => p.variable)).toContain("API_KEYS");
});

test("an empty API_KEYS is fatal, not an intentional lockout", () => {
  // `API_KEYS=""` in a deploy config is a mistake. Treating it as "reject everything on
  // purpose" would leave the service running and useless.
  const { problems } = checkEnv({ API_KEYS: "   " });
  expect(problems).toHaveLength(1);
});

test("an API_KEYS with no `=` is fatal", () => {
  // The format is `label=key`. A bare value yields no usable key and the client sees a plain
  // 401, with nothing pointing at the server side being malformed - a failure this repo has
  // already paid for once.
  const { problems } = checkEnv({ API_KEYS: "justakey" });
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
    STELLARINDEX_API_KEY: "sip_test",
    SOROSWAP_API_KEY: "sk_test",
    ADMIN_API_TOKEN: "admin_test_token",
    FIRESTORE_PROJECT_ID: "test-project",
    INTEGRATOR_AUTH_SECRET: "test-integrator-auth-secret-0123456789",
  });
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
    STELLARINDEX_API_KEY: "sip_test",
    SOROSWAP_API_KEY: "sk_test",
    ADMIN_API_TOKEN: "admin_test_token",
    FIRESTORE_PROJECT_ID: "test-project",
    INTEGRATOR_AUTH_SECRET: "test-integrator-auth-secret-0123456789",
  });
  expect(problems).toEqual([]);
  expect(warnings.map((w) => w.variable).sort()).toEqual([
    "FEE_ACCOUNT_SECRET_MAINNET",
    "FEE_ACCOUNT_SECRET_TESTNET",
  ]);
});

test("a missing STELLARINDEX_API_KEY warns rather than blocking the boot", () => {
  const { problems, warnings } = checkEnv({
    API_KEYS: "ci=abc",
    MEDIATOR_SECRET_TESTNET: "S...",
    MEDIATOR_SECRET_MAINNET: "S...",
    FEE_ACCOUNT_SECRET_TESTNET: "S...",
    FEE_ACCOUNT_SECRET_MAINNET: "S...",
    SOROSWAP_API_KEY: "sk_test",
    OCTOPOS_API_KEY: "oct_abc123",
    ADMIN_API_TOKEN: "admin_test_token",
    FIRESTORE_PROJECT_ID: "test-project",
    INTEGRATOR_AUTH_SECRET: "test-integrator-auth-secret-0123456789",
  });
  expect(problems).toEqual([]);
  expect(warnings.map((w) => w.variable)).toEqual(["STELLARINDEX_API_KEY"]);
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
    STELLARINDEX_API_KEY: "sip_test",
    ADMIN_API_TOKEN: "admin_test_token",
    FIRESTORE_PROJECT_ID: "test-project",
    INTEGRATOR_AUTH_SECRET: "test-integrator-auth-secret-0123456789",
  });
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
    STELLARINDEX_API_KEY: "sip_test",
    SOROSWAP_API_KEY: "sk_test",
  };
  const { problems, warnings } = checkEnv(base);
  expect(problems).toEqual([]);
  expect(warnings.map((w) => w.variable).sort()).toEqual([
    "ADMIN_API_TOKEN",
    "FIRESTORE_PROJECT_ID",
    "INTEGRATOR_AUTH_SECRET",
  ]);
});

test.each(["", "   ", "(default)", "restore-drill", "abcd"])(
  "FIRESTORE_DATABASE_ID %p boots",
  (id) => {
    const { problems, warnings } = checkEnv({
      ...OK,
      FIRESTORE_DATABASE_ID: id,
    });
    expect(problems).toEqual([]);
    expect(warnings).toEqual([]);
  }
);

test.each(["Restore-Drill", "abc", "restore-", "1restore", "re_store", "a".repeat(64)])(
  "an invalid FIRESTORE_DATABASE_ID %p is fatal",
  (id) => {
    const { problems } = checkEnv({ ...OK, FIRESTORE_DATABASE_ID: id });
    expect(problems.map((p) => p.variable)).toEqual(["FIRESTORE_DATABASE_ID"]);
    expect(problems[0]!.message).not.toContain(id);
  }
);

test("the failure message names the variable and where to look", () => {
  const { problems } = checkEnv({});
  const msg = formatEnvFailure(problems);
  expect(msg).toContain("API_KEYS");
  expect(msg).toContain(".env.example");
});

test("an API_KEYS with an empty label or key is fatal", () => {
  // A substring check for "=" passed all of these, and each yields zero usable keys - so the
  // process booted green and every authenticated route 401'd, which is the exact state the
  // check exists to prevent. Counted with the same rule ApiKeyService parses by.
  for (const value of ["=abc123", "label=", " = ", "label=,other="]) {
    const { problems } = checkEnv({ API_KEYS: value });
    expect(problems.map((p) => p.variable)).toContain("API_KEYS");
  }
});

test("a key containing '=' is accepted - base64 padding is not malformed", () => {
  // indexOf, not split: the key is everything after the FIRST "=".
  const { problems } = checkEnv({ API_KEYS: "label=abc==" });
  expect(problems).toEqual([]);
});

test("several comma-separated pairs are accepted", () => {
  const { problems } = checkEnv({ API_KEYS: "a=1,b=2" });
  expect(problems).toEqual([]);
});

const MAINNET_SET = {
  STELLAR_RPC_MAINNET: "https://rpc.test",
  PATH_ROUTING_API_MAINNET: "https://h.test",
};

function endpointCheck(env: Record<string, string>) {
  return checkEnv({ ...OK, ...env });
}

test("in production an unset mainnet endpoint refuses to start, naming each one", () => {
  const { problems, warnings } = endpointCheck({ NODE_ENV: "production" });
  expect(warnings).toEqual([]);
  expect(problems.map((p) => p.variable)).toEqual([
    "STELLAR_RPC_MAINNET",
    "PATH_ROUTING_API_MAINNET",
  ]);
  const msg = formatEnvFailure(problems);
  expect(msg).toContain("Refusing to start");
  expect(msg).toContain("STELLAR_RPC_MAINNET is not set");
  expect(msg).toContain("PATH_ROUTING_API_MAINNET is not set");
});

test("in production each mainnet endpoint is required on its own", () => {
  const rpcOnly = endpointCheck({
    NODE_ENV: "production",
    STELLAR_RPC_MAINNET: "https://rpc.test",
  });
  expect(rpcOnly.problems.map((p) => p.variable)).toEqual(["PATH_ROUTING_API_MAINNET"]);
  const routingOnly = endpointCheck({
    NODE_ENV: "production",
    PATH_ROUTING_API_MAINNET: "https://h.test",
  });
  expect(routingOnly.problems.map((p) => p.variable)).toEqual(["STELLAR_RPC_MAINNET"]);
});

test("in production a value that names no endpoint counts as unset", () => {
  for (const value of ["", "   ", ",", " , ,"]) {
    const { problems } = endpointCheck({
      NODE_ENV: "production",
      STELLAR_RPC_MAINNET: value,
      PATH_ROUTING_API_MAINNET: value,
    });
    expect(problems.map((p) => p.variable)).toEqual([
      "STELLAR_RPC_MAINNET",
      "PATH_ROUTING_API_MAINNET",
    ]);
  }
});

test("in production explicit mainnet endpoints boot", () => {
  const { problems, warnings } = endpointCheck({ NODE_ENV: "production", ...MAINNET_SET });
  expect(problems).toEqual([]);
  expect(warnings).toEqual([]);
});

test("outside production an unset mainnet endpoint is not a finding", () => {
  for (const NODE_ENV of ["development", "test"]) {
    const { problems, warnings } = endpointCheck({ NODE_ENV });
    expect(problems).toEqual([]);
    expect(warnings).toEqual([]);
  }
  expect(endpointCheck({}).problems).toEqual([]);
});

test("a legacy name counts as explicit, and an empty new name overrides it", () => {
  const production = { NODE_ENV: "production" };
  const legacy = {
    NEXT_PUBLIC_STELLAR_RPC_MAINNET: "https://rpc.test",
    NEXT_PUBLIC_PATH_ROUTING_API_MAINNET: "https://h.test",
  };
  expect(endpointCheck({ ...production, ...legacy }).problems).toEqual([]);
  const cleared = endpointCheck({ ...production, ...legacy, STELLAR_RPC_MAINNET: "" });
  expect(cleared.problems.map((p) => p.variable)).toEqual(["STELLAR_RPC_MAINNET"]);
});

test("an unset testnet endpoint is never a finding", () => {
  const { problems, warnings } = endpointCheck({ ...MAINNET_SET, NODE_ENV: "production" });
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

test("a kill switch that is unset or true boots silently", () => {
  for (const value of [undefined, "", "true", " TRUE "]) {
    const env: NodeJS.ProcessEnv = { ...OK, FEE_SPONSORSHIP_ENABLED: value };
    const { problems, warnings } = checkEnv(env);
    expect(problems).toEqual([]);
    expect(warnings).toEqual([]);
  }
});

test("a kill switch set to false boots and says what is paused", () => {
  const { problems, warnings } = checkEnv({
    ...OK,
    MEDIATOR_FORWARD_ENABLED: "false",
    BLEND_EXIT_ENABLED: " False ",
  });
  expect(problems).toEqual([]);
  expect(warnings).toEqual([
    {
      variable: "MEDIATOR_FORWARD_ENABLED",
      message:
        "MEDIATOR_FORWARD_ENABLED is false - exchange closes through the relay account are paused.",
    },
    {
      variable: "BLEND_EXIT_ENABLED",
      message: "BLEND_EXIT_ENABLED is false - blend exits are paused.",
    },
  ]);
});

test("a kill switch that is neither true nor false refuses the boot instead of reading as on", () => {
  for (const value of ["fasle", "0", "no", "off"]) {
    const { problems } = checkEnv({ ...OK, PHOENIX_EXIT_ENABLED: value });
    expect(problems).toEqual([
      { variable: "PHOENIX_EXIT_ENABLED", message: "PHOENIX_EXIT_ENABLED must be true or false." },
    ]);
  }
});
