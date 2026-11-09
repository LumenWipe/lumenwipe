// Runs scripts/migration-check.sh against stubbed `gcloud`, `gh` and `curl` on PATH. Each stub
// records its arguments and answers from a simulated environment, so every test also proves the
// script only ever reads.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "migration-check.sh");
const PROJECT = "test-project";
const REPO = "example-org/example-repo";
const DOMAIN = "api.example.invalid";
const PLATFORM = "https://svc.example.invalid";
const RUNTIME_SA = `api-runtime@${PROJECT}.iam.gserviceaccount.com`;
const CHANNEL = `projects/${PROJECT}/notificationChannels/1`;
const TEST_KEY = "lw_test_not_a_real_key";
const CHECKS = [
  "health",
  "ingress-invoker",
  "deploy-pipeline",
  "revision",
  "service-account",
  "test-key",
  "domain",
  "billing",
  "logging",
  "alerting",
  "org-policies",
];

const GCLOUD_READS = [
  "run services describe",
  "run services get-iam-policy",
  "iam workload-identity-pools providers describe",
  "projects get-iam-policy",
  "run domain-mappings describe",
  "billing projects describe",
  "billing budgets list",
  "logging buckets list",
  "logging sinks list",
  "beta monitoring policies list",
  "monitoring uptime list-configs",
  "org-policies list",
];
const READ_VERBS = new Set(["describe", "list", "get-iam-policy", "list-configs"]);
const CURL_WRITE_FLAGS =
  /^(-X|--request|-d|--data.*|-F|--form.*|-T|--upload-file|-I|--head|--json|-G|--get)$/;

interface Http {
  status: number;
  body: unknown;
  key?: string;
}
type Gcloud = Record<string, unknown>;
interface World {
  gcloud: Gcloud;
  gh: unknown;
  http: Record<string, Http>;
}

const STUB = String.raw`
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const tool = process.argv[2];
const args = process.argv.slice(3);
const env = process.env;
appendFileSync(env.SIM_LOG, JSON.stringify([tool, ...args]) + "\n");
const world = JSON.parse(readFileSync(env.SIM_WORLD, "utf8"));
const positional = args.filter((a) => !a.startsWith("-")).join(" ");
if (tool === "gcloud") {
  const key = Object.keys(world.gcloud).find((k) => positional.startsWith(k));
  if (!key) process.exit(3);
  const value = world.gcloud[key];
  if (value && value.denied) {
    console.error("ERROR: (gcloud) PERMISSION_DENIED: the caller does not have permission");
    process.exit(1);
  }
  console.log(JSON.stringify(value));
} else if (tool === "gh") {
  if (positional.startsWith("run list")) console.log(JSON.stringify(world.gh));
  else process.exit(3);
} else if (tool === "curl") {
  let out, fmt, header, fail = false, verbose = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-o") out = args[++i];
    else if (a === "-w") fmt = args[++i];
    else if (a === "-H") header = args[++i];
    else if (a === "--max-time") i++;
    else if (/^-[a-zA-Z]+$/.test(a)) { if (a.includes("f")) fail = true; if (a.includes("v")) verbose = true; }
  }
  const url = args[args.length - 1];
  const sent = header && header.startsWith("@") ? readFileSync(header.slice(1), "utf8").trim() : "";
  const r = world.http[url] || { status: 404, body: "not found" };
  const ok = !r.key || sent === "Authorization: Bearer " + r.key;
  const status = ok ? r.status : 401;
  const body = ok ? JSON.stringify(r.body) : JSON.stringify({ error: { code: "invalid_api_key" } });
  if (verbose) console.error("*  expire date: Feb  1 00:00:00 2027 GMT");
  if (fail && status >= 400) process.exit(22);
  if (out) writeFileSync(out, body); else process.stdout.write(body);
  if (fmt) process.stdout.write(fmt.replace("%{http_code}", String(status)));
} else {
  process.exit(3);
}
`;

let dir: string;

function healthyWorld(): World {
  const ready = [{ type: "Ready", status: "True" }];
  return {
    gcloud: {
      "run services describe": {
        metadata: { annotations: { "run.googleapis.com/ingress": "all" } },
        spec: { template: { spec: { serviceAccountName: RUNTIME_SA } } },
        status: {
          url: PLATFORM,
          latestCreatedRevisionName: "lumenwipe-api-00042",
          latestReadyRevisionName: "lumenwipe-api-00042",
          conditions: ready,
        },
      },
      "run services get-iam-policy": {
        bindings: [{ role: "roles/run.invoker", members: ["allUsers"] }],
      },
      "iam workload-identity-pools providers describe": {
        attributeCondition: `assertion.repository == '${REPO}'`,
      },
      "projects get-iam-policy": {
        bindings: [
          { role: "roles/datastore.user", members: [`serviceAccount:${RUNTIME_SA}`] },
          {
            role: "roles/run.admin",
            members: [`serviceAccount:deployer@${PROJECT}.iam.gserviceaccount.com`],
          },
        ],
      },
      "run domain-mappings describe": { status: { conditions: ready } },
      "billing projects describe": {
        billingEnabled: true,
        billingAccountName: "billingAccounts/000000-000000-000000",
      },
      "billing budgets list": [
        { displayName: "monthly", thresholdRules: [{ thresholdPercent: 0.5 }] },
      ],
      "logging buckets list": [
        { name: `projects/${PROJECT}/locations/global/buckets/_Default`, retentionDays: 30 },
        { name: `projects/${PROJECT}/locations/global/buckets/_Required`, retentionDays: 400 },
      ],
      "logging sinks list": [{ name: "_Required" }, { name: "_Default" }],
      "beta monitoring policies list": [
        { displayName: "API down", enabled: true, notificationChannels: [CHANNEL] },
      ],
      "monitoring uptime list-configs": [{ displayName: "API health" }],
      "org-policies list": [{ constraint: "constraints/iam.allowedPolicyMemberDomains" }],
    },
    gh: [{ conclusion: "success", url: `https://github.com/${REPO}/actions/runs/1` }],
    http: {
      [`${PLATFORM}/health`]: { status: 200, body: { status: "ok" } },
      [`https://${DOMAIN}/health`]: { status: 200, body: { status: "ok" } },
      [`https://${DOMAIN}/health/deep`]: { status: 200, body: { status: "ok" } },
      [`${PLATFORM}/health/deep`]: { status: 200, body: { status: "ok" } },
      [`https://${DOMAIN}/v1/testnet/close/status`]: {
        status: 400,
        body: { error: { code: "invalid_source" } },
        key: TEST_KEY,
      },
    },
  };
}

let world: World;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "migration-check-"));
  writeFileSync(join(dir, "stub.cjs"), STUB);
  for (const tool of ["gcloud", "gh", "curl"]) {
    writeFileSync(join(dir, tool), `#!/bin/sh\nexec bun "${join(dir, "stub.cjs")}" ${tool} "$@"\n`);
    chmodSync(join(dir, tool), 0o755);
  }
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  world = healthyWorld();
});

const FULL_ENV = {
  API_DOMAIN: DOMAIN,
  GITHUB_REPOSITORY: REPO,
  WIF_PROVIDER: "projects/0/locations/global/workloadIdentityPools/p/providers/github",
  CHECK_API_KEY: TEST_KEY,
  ALERT_CHANNEL: CHANNEL,
};

async function run(env: Record<string, string> = FULL_ENV) {
  const log = join(dir, "calls.log");
  const summary = join(dir, "summary.md");
  writeFileSync(join(dir, "world.json"), JSON.stringify(world));
  writeFileSync(log, "");
  writeFileSync(summary, "");
  const proc = Bun.spawn(["bash", SCRIPT], {
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      GCP_PROJECT_ID: PROJECT,
      GCP_REGION: "us-central1",
      SERVICE: "lumenwipe-api",
      GITHUB_STEP_SUMMARY: summary,
      SIM_WORLD: join(dir, "world.json"),
      SIM_LOG: log,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const calls = readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  const results = Object.fromEntries(
    stdout
      .split("\n")
      .map((line) => line.match(/^(PASS|FAIL|SKIPPED)\s+(\S+)/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => [m[2], m[1]])
  );
  assertReadOnly(calls);
  return { code, stdout, calls, results, summary: readFileSync(summary, "utf8") };
}

function assertReadOnly(calls: string[][]) {
  for (const [tool, ...args] of calls) {
    const positional = args.filter((a) => !a.startsWith("-")).join(" ");
    if (tool === "gcloud") {
      const read = GCLOUD_READS.find((prefix) => positional.startsWith(prefix));
      expect(read, `gcloud ${positional}`).toBeDefined();
      expect(READ_VERBS.has(read!.split(" ").at(-1)!)).toBe(true);
    } else if (tool === "gh") {
      expect(positional.startsWith("run list"), `gh ${positional}`).toBe(true);
    } else {
      expect(tool).toBe("curl");
      expect(args.filter((a) => CURL_WRITE_FLAGS.test(a))).toEqual([]);
    }
  }
}

const allAre = (result: string) => Object.fromEntries(CHECKS.map((c) => [c, result]));

test("a healthy environment passes all eleven checks with reads only", async () => {
  const { code, results, stdout, calls } = await run();
  expect(results).toEqual(allAre("PASS"));
  expect(code).toBe(0);
  expect(stdout).toContain("11 passed, 0 failed, 0 skipped");
  expect(stdout).toContain("certificate expires Feb  1 00:00:00 2027 GMT");
  expect(stdout).toContain("in force: iam.allowedPolicyMemberDomains");
  expect(calls.filter(([tool]) => tool === "gcloud").length).toBeGreaterThan(0);
});

test("the services description is read once per run", async () => {
  const { calls } = await run();
  const describes = calls.filter(
    ([tool, ...a]) => tool === "gcloud" && a.slice(0, 3).join(" ") === "run services describe"
  );
  expect(describes).toHaveLength(1);
});

test("the test key never appears in a command line", async () => {
  const { calls } = await run();
  expect(calls.flat().some((a) => a.includes(TEST_KEY))).toBe(false);
});

test("DRILL=fail-check fails the invoker check and the run", async () => {
  const { code, results, summary } = await run({ ...FULL_ENV, DRILL: "fail-check" });
  expect(results).toEqual({ ...allAre("PASS"), "ingress-invoker": "FAIL" });
  expect(code).toBe(1);
  expect(summary).toContain("Drill:");
});

test("checks without their configuration are skipped, not failed", async () => {
  delete world.http[`https://${DOMAIN}/health`];
  const { code, results } = await run({});
  expect(results).toEqual({
    ...allAre("PASS"),
    "deploy-pipeline": "SKIPPED",
    "test-key": "SKIPPED",
    domain: "SKIPPED",
  });
  expect(code).toBe(0);
});

test("a read the identity is denied fails unless SKIP_DENIED=1", async () => {
  world.gcloud["billing projects describe"] = { denied: true };
  world.gcloud["org-policies list"] = { denied: true };
  const strict = await run();
  expect(strict.results.billing).toBe("FAIL");
  expect(strict.results["org-policies"]).toBe("FAIL");
  expect(strict.code).toBe(1);

  const lenient = await run({ ...FULL_ENV, SKIP_DENIED: "1" });
  expect(lenient.results).toEqual({
    ...allAre("PASS"),
    billing: "SKIPPED",
    "org-policies": "SKIPPED",
  });
  expect(lenient.code).toBe(0);
});

test("a failure that is not a denial still fails with SKIP_DENIED=1", async () => {
  world.gcloud["logging sinks list"] = [{ name: "_Required" }];
  const { code, results } = await run({ ...FULL_ENV, SKIP_DENIED: "1" });
  expect(results.logging).toBe("FAIL");
  expect(code).toBe(1);
});

const svc = (w: World) =>
  w.gcloud["run services describe"] as {
    metadata: { annotations: Record<string, string> };
    spec: { template: { spec: { serviceAccountName?: string } } };
    status: { latestReadyRevisionName: string; conditions: unknown[] };
  };

const FAILURES: Array<[string, string, (w: World) => void]> = [
  [
    "the deep health check is down",
    "health",
    (w) => (w.http[`https://${DOMAIN}/health/deep`] = { status: 503, body: {} }),
  ],
  ["the platform URL is down", "health", (w) => delete w.http[`${PLATFORM}/health`]],
  [
    "ingress changed to internal",
    "ingress-invoker",
    (w) => (svc(w).metadata.annotations["run.googleapis.com/ingress"] = "internal"),
  ],
  [
    "the invoker binding is gone",
    "ingress-invoker",
    (w) => (w.gcloud["run services get-iam-policy"] = { bindings: [] }),
  ],
  [
    "the last manual deploy failed",
    "deploy-pipeline",
    (w) => (w.gh = [{ conclusion: "failure", url: "u" }]),
  ],
  ["no manual deploy has run", "deploy-pipeline", (w) => (w.gh = [])],
  [
    "the trust condition names another repository",
    "deploy-pipeline",
    (w) =>
      (w.gcloud["iam workload-identity-pools providers describe"] = {
        attributeCondition: "assertion.repository == 'example-org/example-repo-fork'",
      }),
  ],
  [
    "the latest revision did not boot",
    "revision",
    (w) => (svc(w).status.latestReadyRevisionName = "lumenwipe-api-00041"),
  ],
  [
    "the service runs as the default account",
    "service-account",
    (w) => delete svc(w).spec.template.spec.serviceAccountName,
  ],
  [
    "the runtime account holds an extra role",
    "service-account",
    (w) =>
      (w.gcloud["projects get-iam-policy"] as { bindings: unknown[] }).bindings.push({
        role: "roles/owner",
        members: [`serviceAccount:${RUNTIME_SA}`],
      }),
  ],
  [
    "the test key does not resolve",
    "test-key",
    (w) => (w.http[`https://${DOMAIN}/v1/testnet/close/status`]!.key = "another-key"),
  ],
  [
    "the domain mapping is not ready",
    "domain",
    (w) => (w.gcloud["run domain-mappings describe"] = { status: { conditions: [] } }),
  ],
  [
    "billing is disabled",
    "billing",
    (w) => (w.gcloud["billing projects describe"] = { billingEnabled: false }),
  ],
  [
    "no budget alert exists",
    "billing",
    (w) => (w.gcloud["billing budgets list"] = [{ displayName: "no alerts" }]),
  ],
  [
    "log retention dropped",
    "logging",
    (w) =>
      (w.gcloud["logging buckets list"] = [
        { name: `projects/${PROJECT}/locations/global/buckets/_Default`, retentionDays: 7 },
      ]),
  ],
  [
    "the _Default sink is disabled",
    "logging",
    (w) =>
      (w.gcloud["logging sinks list"] = [
        { name: "_Required" },
        { name: "_Default", disabled: true },
      ]),
  ],
  [
    "an alert policy is disabled",
    "alerting",
    (w) =>
      (w.gcloud["beta monitoring policies list"] = [
        { enabled: false, notificationChannels: [CHANNEL] },
      ]),
  ],
  [
    "an alert policy is routed elsewhere",
    "alerting",
    (w) =>
      (w.gcloud["beta monitoring policies list"] = [
        { enabled: true, notificationChannels: ["projects/x/notificationChannels/9"] },
      ]),
  ],
  [
    "the uptime check is gone",
    "alerting",
    (w) => (w.gcloud["monitoring uptime list-configs"] = []),
  ],
];

test.each(FAILURES)("%s fails %s and the run", async (_name, check, mutate) => {
  mutate(world);
  const { code, results } = await run();
  expect(results).toEqual({ ...allAre("PASS"), [check]: "FAIL" });
  expect(code).toBe(1);
});

test("the summary lists every check", async () => {
  const { summary } = await run();
  for (const check of CHECKS) expect(summary).toContain(`| ${check} | PASS |`);
});
