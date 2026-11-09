// Runs scripts/deploy-api.sh against a simulated Cloud Run service: `gcloud` on PATH is a stub that
// records every call and keeps the service's revisions and traffic in a JSON file, and every
// revision URL it hands out is served by a local server that answers as that revision's image would.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "deploy-api.sh");
const SERVICE = "lumenwipe-api";
const SHA = "abcdef0123456789abcdef0123456789abcdef01";
const IMAGE = `registry.example/lumenwipe-api:${SHA}`;
const PREV_DIGEST = "registry.example/lumenwipe-api@sha256:" + "1".repeat(64);
const SUFFIX = "abcdef0-42-1";
const CAND = `${SERVICE}-${SUFFIX}`;
const RESTORED = `${CAND}-restore`;
const EXCHANGE = "GEXCHANGE";

interface Revision {
  name: string;
  image: string;
}
interface Traffic {
  revisionName: string;
  percent?: number;
  latestRevision?: boolean;
  tag?: string;
}
interface Sim {
  revisions: Revision[];
  traffic: Traffic[];
  latestReady: string;
}
interface Behaviour {
  gitSha?: string;
  deep?: number;
  // Dependencies /health/deep reports down; any makes it answer 503, as Terminus does.
  deepDown?: string[];
  // Pins traffic to this revision when /health/deep is first asked of this image, as a hand edit would.
  deepMovesTrafficTo?: string;
  serviceFails?: boolean;
  healthFails?: boolean;
}

const STUB = String.raw`
const { readFileSync, writeFileSync, appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
const env = process.env;
appendFileSync(env.SIM_LOG, JSON.stringify(args) + "\n");
const line = args.join(" ");
if (env.SIM_FAIL && new RegExp(env.SIM_FAIL).test(line)) process.exit(1);
// SIM_FAIL_ONCE fails only the first matching call, as a transient API error would.
if (env.SIM_FAIL_ONCE && new RegExp(env.SIM_FAIL_ONCE).test(line)) {
  const marker = env.SIM_STATE + ".failed-once";
  if (!require("node:fs").existsSync(marker)) {
    writeFileSync(marker, "");
    process.exit(1);
  }
}
const sim = JSON.parse(readFileSync(env.SIM_STATE, "utf8"));
const save = () => {
  writeFileSync(env.SIM_STATE, JSON.stringify(sim));
  for (const t of sim.traffic) if (t.percent) appendFileSync(env.SIM_SERVED, t.revisionName + "\n");
};
const flag = (name) => {
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1];
  const eq = args.find((a) => a.startsWith(name + "="));
  return eq ? eq.slice(name.length + 1) : undefined;
};
const percents = () => sim.traffic.filter((t) => t.percent);
const tags = () => sim.traffic.filter((t) => t.tag);
const [, group, verb] = args;
if (group === "services" && verb === "describe") {
  const traffic = sim.traffic.map((t) => (t.tag ? { ...t, url: env.SIM_BASE + "/rev/" + t.revisionName } : t));
  console.log(JSON.stringify({ status: { url: env.SIM_BASE + "/svc", latestReadyRevisionName: sim.latestReady, traffic } }));
} else if (group === "revisions" && verb === "describe") {
  const rev = sim.revisions.find((r) => r.name === args[3]);
  console.log(rev ? rev.image : "");
} else if (group === "deploy") {
  const name = env.SIM_SERVICE + "-" + flag("--revision-suffix");
  if (sim.revisions.some((r) => r.name === name)) process.exit(1);
  // --no-traffic pins traffic that followed the latest revision to the revision serving it.
  const pinned = percents().map((t) =>
    !t.latestRevision ? t : args.includes("--no-traffic") ? { revisionName: t.revisionName, percent: t.percent } : { ...t, revisionName: name }
  );
  const tag = flag("--tag");
  sim.revisions.push({ name, image: flag("--image") });
  sim.latestReady = name;
  sim.traffic = [...pinned, ...tags().filter((t) => t.tag !== tag), { revisionName: name, tag }];
  if (env.SIM_INTRUDE && tag === "candidate") {
    sim.revisions.push({ name: "intruder", image: flag("--image") });
    sim.latestReady = "intruder";
  }
  save();
} else if (group === "services" && verb === "update-traffic") {
  const to = flag("--to-revisions");
  const remove = flag("--remove-tags");
  if (args.includes("--to-latest")) {
    sim.traffic = [{ latestRevision: true, percent: 100, revisionName: sim.latestReady }, ...tags()];
  } else if (to) {
    const [name, percent] = to.split("=");
    sim.traffic = [{ revisionName: name, percent: Number(percent) }, ...tags()];
  } else if (remove) {
    sim.traffic = sim.traffic.filter((t) => t.tag !== remove);
  }
  save();
} else {
  process.exit(3);
}
`;

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let behaviours: Record<string, Behaviour>;
let authHeaders: string[];

const statePath = () => join(dir, "sim.json");
const readSim = (): Sim => JSON.parse(readFileSync(statePath(), "utf8"));

function respond(rev: Revision | undefined, path: string, req: Request, viaService: boolean) {
  const b = (rev && behaviours[rev.image]) ?? {};
  if (!rev || (viaService && b.serviceFails)) return new Response("down", { status: 500 });
  if (path === "/health")
    return b.healthFails ? new Response("down", { status: 503 }) : Response.json({ status: "ok" });
  if (path === "/") return Response.json({ gitSha: b.gitSha ?? null });
  if (path === "/health/deep") {
    const down = new Set(b.deepDown ?? []);
    const status = b.deep ?? (down.size > 0 ? 503 : 200);
    const details = Object.fromEntries(
      ["rpc_mainnet", "rpc_testnet", "exchange_registry"].map((key) => [
        key,
        { status: down.has(key) ? "down" : "up" },
      ])
    );
    return Response.json({ status: status === 200 ? "ok" : "error", details }, { status });
  }
  if (path === "/v1/config/exchange-registry")
    return Response.json({ entries: [{ address: EXCHANGE }] });
  const account = path.match(/^\/v1\/mainnet\/account\/(\w+)$/);
  if (account) {
    authHeaders.push(req.headers.get("authorization") ?? "");
    if (req.headers.get("authorization") !== "Bearer smoke-key")
      return new Response("no", { status: 401 });
    return Response.json({ address: account[1] });
  }
  return new Response("not found", { status: 404 });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "deploy-api-"));
  writeFileSync(join(dir, "stub.cjs"), STUB);
  writeFileSync(join(dir, "gcloud"), `#!/bin/sh\nexec bun "${join(dir, "stub.cjs")}" "$@"\n`);
  chmodSync(join(dir, "gcloud"), 0o755);
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      const sim = readSim();
      const byName = (name: string) => sim.revisions.find((r) => r.name === name);
      const rev = url.pathname.match(/^\/rev\/([^/]+)(\/.*)?$/);
      if (rev) {
        const moveTo = behaviours[byName(rev[1])?.image ?? ""]?.deepMovesTrafficTo;
        if (moveTo && rev[2] === "/health/deep") {
          writeSim({
            ...sim,
            traffic: [{ revisionName: moveTo, percent: 100 }, ...sim.traffic.filter((t) => t.tag)],
          });
        }
        return respond(byName(rev[1]), rev[2] ?? "/", req, false);
      }
      const svc = url.pathname.match(/^\/svc(\/.*)?$/);
      if (svc) {
        const serving = sim.traffic.find((t) => t.percent === 100);
        return respond(serving && byName(serving.revisionName), svc[1] ?? "/", req, true);
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  authHeaders = [];
  behaviours = {
    [IMAGE]: { gitSha: SHA },
    [PREV_DIGEST]: { gitSha: "0".repeat(40) },
  };
  // A follows the latest revision; B was created after it and never served. Rollback must pick A.
  writeSim({
    revisions: [
      {
        name: "lumenwipe-api-old",
        image: "registry.example/lumenwipe-api@sha256:" + "0".repeat(64),
      },
      { name: "lumenwipe-api-a", image: PREV_DIGEST },
    ],
    traffic: [{ latestRevision: true, percent: 100, revisionName: "lumenwipe-api-a" }],
    latestReady: "lumenwipe-api-a",
  });
});

function writeSim(sim: Sim) {
  writeFileSync(statePath(), JSON.stringify(sim));
}

async function run(command: string, env: Record<string, string> = {}) {
  const log = join(dir, "calls.log");
  const summary = join(dir, "summary.md");
  const served = join(dir, "served.log");
  rmSync(`${statePath()}.failed-once`, { force: true });
  writeFileSync(served, "");
  writeFileSync(log, "");
  writeFileSync(summary, "");
  const proc = Bun.spawn(["bash", SCRIPT, command], {
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      SERVICE,
      REGION: "us-central1",
      IMAGE,
      GITHUB_SHA: SHA,
      GITHUB_RUN_ID: "42",
      GITHUB_RUN_ATTEMPT: "1",
      RUNNER_TEMP: dir,
      GITHUB_STEP_SUMMARY: summary,
      RETRY_DELAY: "0",
      SMOKE_TRIES: "2",
      VERIFY_TRIES: "2",
      DEEP_TRIES: "2",
      DEEP_DELAY: "0",
      SIM_STATE: statePath(),
      SIM_LOG: log,
      SIM_SERVED: served,
      SIM_BASE: `http://127.0.0.1:${server.port}`,
      SIM_SERVICE: SERVICE,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  const calls = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => describeCall(JSON.parse(l) as string[]));
  // Every revision that held traffic at any point of the run.
  const everServed = new Set(readFileSync(served, "utf8").split("\n").filter(Boolean));
  return {
    code,
    stdout,
    calls,
    everServed,
    summary: readFileSync(summary, "utf8"),
    sim: readSim(),
  };
}

// One readable line per gcloud call: the verb and the arguments that decide what it does.
function describeCall(args: string[]): string {
  const value = (name: string) =>
    args.find((a) => a.startsWith(`${name}=`)) ?? args[args.indexOf(name) + 1];
  if (args[1] === "services" && args[2] === "describe") return "services describe";
  if (args[1] === "revisions") return `revisions describe ${args[3]}`;
  if (args[1] === "deploy")
    return `deploy --image ${value("--image")} --no-traffic --tag ${value("--tag")} --revision-suffix ${value("--revision-suffix")}`;
  const op = args.find(
    (a) => a === "--to-latest" || a.startsWith("--to-revisions=") || a.startsWith("--remove-tags=")
  );
  return `update-traffic ${op}`;
}

const serving = (sim: Sim) => sim.traffic.filter((t) => t.percent);

const DEPLOY_CANDIDATE = `deploy --image ${IMAGE} --no-traffic --tag candidate --revision-suffix ${SUFFIX}`;
const DEPLOY_RESTORE = `deploy --image ${PREV_DIGEST} --no-traffic --tag restore --revision-suffix ${SUFFIX}-restore`;
const CAPTURE = ["services describe", "revisions describe lumenwipe-api-a"];
const RESTORE = [
  DEPLOY_RESTORE,
  "services describe",
  "update-traffic --to-latest",
  "services describe",
  "update-traffic --remove-tags=restore",
];

describe("deploy", () => {
  test("a passing candidate takes all traffic and follows the latest revision", async () => {
    const r = await run("deploy");
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([
      ...CAPTURE,
      DEPLOY_CANDIDATE,
      "services describe",
      "services describe",
      "update-traffic --to-latest",
      "services describe",
      "update-traffic --remove-tags=candidate",
    ]);
    expect(r.sim.traffic).toEqual([{ latestRevision: true, percent: 100, revisionName: CAND }]);
    expect(r.summary).toContain(`Commit: \`${SHA}\``);
    expect(r.summary).toContain(`Candidate: \`${CAND}\``);
    expect(r.summary).toContain("Promoted:");
    expect(r.stdout).toContain("API_SMOKE_KEY secret is not set");
  });

  test("a failing smoke check never moves traffic, then the restore makes traffic follow the latest revision again", async () => {
    behaviours[IMAGE] = { gitSha: SHA, deep: 503 };
    const r = await run("deploy");
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([
      ...CAPTURE,
      DEPLOY_CANDIDATE,
      "services describe",
      "update-traffic --remove-tags=candidate",
      ...RESTORE,
    ]);
    expect(r.sim.traffic).toEqual([{ latestRevision: true, percent: 100, revisionName: RESTORED }]);
    expect(r.sim.revisions.find((rev) => rev.name === RESTORED)?.image).toBe(PREV_DIGEST);
    expect(r.summary).toContain("| /health/deep | **fail** |");
    expect(r.everServed.has(CAND)).toBe(false);
    expect(r.stdout).toContain(
      `::error::the candidate failed its smoke test: ${CAND} received no traffic and lumenwipe-api-a still serves`
    );
  });

  test("the fail-smoke drill fails before promotion and ends restored", async () => {
    const r = await run("deploy", { DRILL: "fail-smoke" });
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([
      ...CAPTURE,
      DEPLOY_CANDIDATE,
      "services describe",
      "update-traffic --remove-tags=candidate",
      ...RESTORE,
    ]);
    expect(r.summary).toContain("| / reports this commit | **fail** |");
    expect(r.everServed.has(CAND)).toBe(false);
    expect(r.sim.traffic).toEqual([{ latestRevision: true, percent: 100, revisionName: RESTORED }]);
  });

  test("an RPC down on the candidate and on the serving revision is an upstream outage: the smoke test continues", async () => {
    behaviours[IMAGE] = { gitSha: SHA, deepDown: ["rpc_testnet"] };
    behaviours[PREV_DIGEST] = { gitSha: "0".repeat(40), deepDown: ["rpc_testnet"] };
    const r = await run("deploy");
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([
      ...CAPTURE,
      DEPLOY_CANDIDATE,
      "services describe",
      "services describe",
      "services describe",
      "update-traffic --to-latest",
      "services describe",
      "update-traffic --remove-tags=candidate",
    ]);
    expect(r.summary).toContain("| /health/deep | upstream (rpc_testnet) |");
    expect(r.summary).toContain("| /v1/config/exchange-registry | pass |");
    expect(r.stdout).toContain(
      "::warning::/health/deep reports rpc_testnet down on the candidate and on lumenwipe-api-a, which serves now"
    );
    expect(r.sim.traffic).toEqual([{ latestRevision: true, percent: 100, revisionName: CAND }]);
  });

  test.each([
    ["only on the candidate", ["rpc_testnet"], [], "down only on the candidate: rpc_testnet"],
    [
      "on the candidate beyond what the serving revision shares",
      ["rpc_mainnet", "rpc_testnet"],
      ["rpc_testnet"],
      "down only on the candidate: rpc_mainnet",
    ],
    [
      "outside the RPCs, even when the serving revision shares it",
      ["exchange_registry"],
      ["exchange_registry"],
      "down: exchange_registry",
    ],
  ])("a dependency down %s abandons the candidate", async (_, candidate, prev, reason) => {
    behaviours[IMAGE] = { gitSha: SHA, deepDown: candidate };
    behaviours[PREV_DIGEST] = { gitSha: "0".repeat(40), deepDown: prev };
    const r = await run("deploy");
    expect(r.code).toBe(1);
    expect(r.summary).toContain(`| /health/deep | **fail** (${reason}) |`);
    expect(r.summary).not.toContain("upstream");
    // The serving revision is read to compare only when every dependency down is an RPC.
    const compared = candidate.every((name) => name.startsWith("rpc_"));
    expect(r.calls).toEqual([
      ...CAPTURE,
      DEPLOY_CANDIDATE,
      "services describe",
      ...(compared ? ["services describe"] : []),
      "update-traffic --remove-tags=candidate",
      ...RESTORE,
    ]);
    expect(r.everServed.has(CAND)).toBe(false);
    expect(r.sim.traffic).toEqual([{ latestRevision: true, percent: 100, revisionName: RESTORED }]);
  });

  test("a serving revision that cannot be read abandons the candidate", async () => {
    behaviours[IMAGE] = { gitSha: SHA, deepDown: ["rpc_testnet"] };
    behaviours[PREV_DIGEST] = { gitSha: "0".repeat(40), serviceFails: true };
    const r = await run("deploy");
    expect(r.code).toBe(1);
    expect(r.summary).toContain(
      "| /health/deep | **fail** (down: rpc_testnet; lumenwipe-api-a could not be read to compare) |"
    );
    expect(r.everServed.has(CAND)).toBe(false);
    expect(r.stdout).toContain(
      `::error::the candidate failed its smoke test: ${CAND} received no traffic`
    );
  });

  test("a service URL no longer serving the captured revision is never compared against", async () => {
    // Traffic moved by hand to another revision mid-run: its view says nothing about the captured one.
    behaviours[IMAGE] = {
      gitSha: SHA,
      deepDown: ["rpc_testnet"],
      deepMovesTrafficTo: "lumenwipe-api-old",
    };
    behaviours["registry.example/lumenwipe-api@sha256:" + "0".repeat(64)] = {
      deepDown: ["rpc_testnet"],
    };
    const r = await run("deploy");
    expect(r.code).toBe(1);
    expect(r.summary).toContain("could not be read to compare) |");
    expect(r.everServed.has(CAND)).toBe(false);
  });

  test("the fail-smoke drill still fails when /health/deep would count as upstream", async () => {
    behaviours[IMAGE] = { gitSha: SHA, deepDown: ["rpc_testnet"] };
    behaviours[PREV_DIGEST] = { gitSha: "0".repeat(40), deepDown: ["rpc_testnet"] };
    const r = await run("deploy", { DRILL: "fail-smoke" });
    expect(r.code).toBe(1);
    expect(r.summary).toContain("| / reports this commit | **fail** |");
    expect(r.summary).not.toContain("/health/deep");
    expect(r.everServed.has(CAND)).toBe(false);
  });

  test("a failure after promotion rolls back to the revision captured at the start, not the one before the candidate", async () => {
    // B is newer than A and never served: a positional "previous revision" would pick it.
    writeSim({
      revisions: [
        { name: "lumenwipe-api-a", image: PREV_DIGEST },
        {
          name: "lumenwipe-api-b",
          image: "registry.example/lumenwipe-api@sha256:" + "2".repeat(64),
        },
      ],
      traffic: [{ revisionName: "lumenwipe-api-a", percent: 100 }],
      latestReady: "lumenwipe-api-b",
    });
    behaviours[IMAGE] = { gitSha: SHA, serviceFails: true };
    const r = await run("deploy");
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([
      ...CAPTURE,
      DEPLOY_CANDIDATE,
      "services describe",
      "services describe",
      "update-traffic --to-latest",
      "services describe",
      "update-traffic --to-revisions=lumenwipe-api-a=100",
      "services describe",
      "update-traffic --remove-tags=candidate",
      ...RESTORE,
    ]);
    expect(r.stdout).toContain(
      `::error::${CAND} failed after promotion; rolling back to lumenwipe-api-a`
    );
    expect(r.summary).toContain("Rolled back: lumenwipe-api-a serves 100 percent.");
    expect(r.sim.traffic).toEqual([{ latestRevision: true, percent: 100, revisionName: RESTORED }]);
  });

  test("a failed restore leaves the captured revision pinned and says how to set a kill switch", async () => {
    behaviours[IMAGE] = { gitSha: SHA, deep: 503 };
    const r = await run("deploy", { SIM_FAIL: "--tag restore" });
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([
      ...CAPTURE,
      DEPLOY_CANDIDATE,
      "services describe",
      "update-traffic --remove-tags=candidate",
      DEPLOY_RESTORE,
      "update-traffic --to-revisions=lumenwipe-api-a=100",
    ]);
    expect(serving(r.sim)).toEqual([{ revisionName: "lumenwipe-api-a", percent: 100 }]);
    expect(r.stdout).toContain(
      "::error::the restore failed: traffic is pinned to lumenwipe-api-a at 100 percent"
    );
    expect(r.summary).toContain("--image=<serving image>");
    expect(r.everServed.has(CAND)).toBe(false);
  });

  test("a restore revision that fails its health check is never given traffic", async () => {
    behaviours[IMAGE] = { gitSha: SHA, deep: 503 };
    behaviours[PREV_DIGEST] = { healthFails: true };
    const r = await run("deploy");
    expect(r.code).toBe(1);
    expect(r.calls.slice(-4)).toEqual([
      DEPLOY_RESTORE,
      "services describe",
      "update-traffic --remove-tags=restore",
      "update-traffic --to-revisions=lumenwipe-api-a=100",
    ]);
    expect(r.sim.traffic).toEqual([{ revisionName: "lumenwipe-api-a", percent: 100 }]);
  });

  test("a rollback that does not take fails with the manual command", async () => {
    behaviours[IMAGE] = { gitSha: SHA, serviceFails: true };
    const r = await run("deploy", { SIM_FAIL: "--to-revisions" });
    expect(r.code).toBe(1);
    const attempt = ["update-traffic --to-revisions=lumenwipe-api-a=100", "services describe"];
    expect(r.calls.slice(-6)).toEqual([...attempt, ...attempt, ...attempt]);
    expect(r.stdout).toContain(
      "::error::the rollback did not take: run gcloud run services update-traffic lumenwipe-api --region us-central1 --to-revisions=lumenwipe-api-a=100"
    );
  });

  test("split traffic stops the run before anything is deployed", async () => {
    writeSim({
      revisions: [
        { name: "lumenwipe-api-a", image: PREV_DIGEST },
        { name: "lumenwipe-api-b", image: PREV_DIGEST },
      ],
      traffic: [
        { revisionName: "lumenwipe-api-a", percent: 50 },
        { revisionName: "lumenwipe-api-b", percent: 50 },
      ],
      latestReady: "lumenwipe-api-b",
    });
    const r = await run("deploy");
    expect(r.code).toBe(1);
    expect(r.calls).toEqual(["services describe"]);
    expect(r.stdout).toContain("nothing was deployed");
  });

  test("a revision created during the run blocks promotion", async () => {
    const r = await run("deploy", { SIM_INTRUDE: "1" });
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([
      ...CAPTURE,
      DEPLOY_CANDIDATE,
      "services describe",
      "services describe",
      "update-traffic --remove-tags=candidate",
      ...RESTORE,
    ]);
    expect(r.sim.traffic).toEqual([{ latestRevision: true, percent: 100, revisionName: RESTORED }]);
    expect(r.stdout).toContain("a newer revision than the candidate appeared during the run");
    expect(r.everServed.has(CAND)).toBe(false);
  });

  test("a rollback whose first traffic update fails is retried until describe shows the captured revision", async () => {
    behaviours[IMAGE] = { gitSha: SHA, serviceFails: true };
    const r = await run("deploy", { SIM_FAIL_ONCE: "--to-revisions" });
    expect(r.code).toBe(1);
    expect(r.calls.slice(7)).toEqual([
      "update-traffic --to-revisions=lumenwipe-api-a=100",
      "services describe",
      "update-traffic --to-revisions=lumenwipe-api-a=100",
      "services describe",
      "update-traffic --remove-tags=candidate",
      ...RESTORE,
    ]);
    expect(r.sim.traffic).toEqual([{ latestRevision: true, percent: 100, revisionName: RESTORED }]);
  });

  test("analyze runs with the smoke key against an address from the served registry", async () => {
    const r = await run("deploy", { API_SMOKE_KEY: "smoke-key" });
    expect(r.code).toBe(0);
    expect(authHeaders).toEqual(["Bearer smoke-key"]);
    expect(r.summary).toContain("| analyze | pass |");
    expect(r.stdout).not.toContain("smoke-key");
    expect(r.summary).not.toContain("smoke-key");
    expect(readFileSync(join(dir, "calls.log"), "utf8")).not.toContain("smoke-key");
  });
});

function writeState(phase: string) {
  writeFileSync(
    join(dir, "deploy-api.state"),
    `prev=lumenwipe-api-a\nprev_image=${PREV_DIGEST}\nsuffix=${SUFFIX}\ncand=${CAND}\nphase=${phase}\n`
  );
}

describe("recover", () => {
  test("a run cancelled after promotion is rolled back and restored", async () => {
    // The state a cancellation leaves right after the candidate was promoted, before it was verified.
    writeSim({
      revisions: [
        { name: "lumenwipe-api-a", image: PREV_DIGEST },
        { name: CAND, image: IMAGE },
      ],
      traffic: [
        { latestRevision: true, percent: 100, revisionName: CAND },
        { revisionName: CAND, tag: "candidate" },
      ],
      latestReady: CAND,
    });
    writeState("promoted");
    const r = await run("recover");
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([
      "update-traffic --to-revisions=lumenwipe-api-a=100",
      "services describe",
      "update-traffic --remove-tags=candidate",
      ...RESTORE,
    ]);
    expect(r.sim.traffic).toEqual([{ latestRevision: true, percent: 100, revisionName: RESTORED }]);
  });

  test("a deploy interrupted before promotion drops the candidate tag and restores", async () => {
    writeSim({
      revisions: [
        { name: "lumenwipe-api-a", image: PREV_DIGEST },
        { name: CAND, image: IMAGE },
      ],
      traffic: [
        { revisionName: "lumenwipe-api-a", percent: 100 },
        { revisionName: CAND, tag: "candidate" },
      ],
      latestReady: CAND,
    });
    writeState("deployed");
    const r = await run("recover");
    expect(r.code).toBe(1);
    expect(r.calls).toEqual(["update-traffic --remove-tags=candidate", ...RESTORE]);
    expect(r.everServed.has(CAND)).toBe(false);
    expect(r.sim.traffic).toEqual([{ latestRevision: true, percent: 100, revisionName: RESTORED }]);
  });

  test("a rollback that did not take is retried by recover", async () => {
    writeSim({
      revisions: [
        { name: "lumenwipe-api-a", image: PREV_DIGEST },
        { name: CAND, image: IMAGE },
      ],
      traffic: [{ latestRevision: true, percent: 100, revisionName: CAND }],
      latestReady: CAND,
    });
    writeState("rollback-failed");
    const r = await run("recover");
    expect(r.code).toBe(1);
    expect(r.calls.slice(0, 2)).toEqual([
      "update-traffic --to-revisions=lumenwipe-api-a=100",
      "services describe",
    ]);
    expect(r.sim.traffic).toEqual([{ latestRevision: true, percent: 100, revisionName: RESTORED }]);
  });

  test("a restore interrupted after it moved traffic is kept", async () => {
    writeSim({
      revisions: [
        { name: "lumenwipe-api-a", image: PREV_DIGEST },
        { name: RESTORED, image: PREV_DIGEST },
      ],
      traffic: [
        { latestRevision: true, percent: 100, revisionName: RESTORED },
        { revisionName: RESTORED, tag: "restore" },
      ],
      latestReady: RESTORED,
    });
    writeState("restoring");
    const r = await run("recover");
    expect(r.code).toBe(1);
    expect(r.calls).toEqual(["services describe", "update-traffic --remove-tags=restore"]);
    expect(r.sim.traffic).toEqual([{ latestRevision: true, percent: 100, revisionName: RESTORED }]);
  });

  test("a restore interrupted before it moved traffic leaves the captured revision pinned", async () => {
    writeSim({
      revisions: [
        { name: "lumenwipe-api-a", image: PREV_DIGEST },
        { name: RESTORED, image: PREV_DIGEST },
      ],
      traffic: [
        { revisionName: "lumenwipe-api-a", percent: 100 },
        { revisionName: RESTORED, tag: "restore" },
      ],
      latestReady: RESTORED,
    });
    writeState("restoring");
    const r = await run("recover");
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([
      "services describe",
      "update-traffic --remove-tags=restore",
      "update-traffic --to-revisions=lumenwipe-api-a=100",
    ]);
    expect(r.sim.traffic).toEqual([{ revisionName: "lumenwipe-api-a", percent: 100 }]);
    expect(r.stdout).toContain("traffic is pinned to lumenwipe-api-a");
  });

  test("a run that failed before deploying anything needs nothing", async () => {
    rmSync(join(dir, "deploy-api.state"), { force: true });
    const r = await run("recover");
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([]);
  });

  test("a run that verified its candidate needs nothing", async () => {
    writeFileSync(join(dir, "deploy-api.state"), "phase=verified\n");
    const r = await run("recover");
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([]);
  });
});
