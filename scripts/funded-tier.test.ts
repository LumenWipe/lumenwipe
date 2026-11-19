import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";

type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string> };
type Job = {
  if?: string;
  environment?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps: Step[];
};
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };

const WORKFLOWS = join(import.meta.dir, "..", ".github", "workflows");
const ADMIN_SECRETS = ["PHOENIX_TESTNET_TOKEN_ADMIN_SECRET", "FXDAO_TESTNET_ORACLE_ADMIN_SECRET"];

const ciText = readFileSync(join(WORKFLOWS, "ci.yml"), "utf8");
const ci = YAML.parse(ciText) as Workflow;
const reviewText = readFileSync(join(WORKFLOWS, "integration-funded-review.yml"), "utf8");
const review = YAML.parse(reviewText) as Workflow;
const nightlyText = readFileSync(join(WORKFLOWS, "e2e-nightly.yml"), "utf8");
const nightly = YAML.parse(nightlyText) as Workflow;
const PLAYGROUND_TOKEN_SECRET = "PLAYGROUND_TOKEN_ADMIN_SECRET_TESTNET";

function jobLines(text: string, job: string): [number, number] {
  const lines = text.split("\n");
  const start = lines.indexOf(`  ${job}:`);
  if (start === -1) throw new Error(`no job ${job}`);
  const next = lines.findIndex((line, i) => i > start && /^ {2}\S/.test(line));
  return [start, next === -1 ? lines.length : next];
}

function linesNaming(text: string, needle: string): number[] {
  return text.split("\n").flatMap((line, i) => (line.includes(needle) ? [i] : []));
}

function aggregate(env: Record<string, string>): number {
  const script = ci.jobs.ci.steps
    .map((s) => s.run ?? "")
    .join("\n")
    .replace(/\$\{\{ needs\.[a-z0-9-]+\.result \}\}/g, "success");
  const result = Bun.spawnSync(["bash", "-e", "-c", script], {
    env: { PATH: process.env.PATH ?? "", GITLEAKS_RESULT: "success", ...env },
  });
  return result.exitCode;
}

describe("ci.yml funded tier", () => {
  test("only the push job, in the testnet-funded environment, names the admin keys", () => {
    const funded = ci.jobs["integration-funded"];
    expect(funded.if).toBe("github.event_name == 'push'");
    expect(funded.environment).toBe("testnet-funded");
    const [start, end] = jobLines(ciText, "integration-funded");
    for (const secret of ADMIN_SECRETS) {
      const lines = linesNaming(ciText, secret);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).toBeGreaterThanOrEqual(start);
        expect(line).toBeLessThan(end);
      }
    }
  });

  test("the PR job runs without an environment, a secret or the keys", () => {
    const pr = ci.jobs["integration-funded-pr"];
    expect(pr.if).toBe("github.event_name == 'pull_request'");
    expect(pr.environment).toBeUndefined();
    const [start, end] = jobLines(ciText, "integration-funded-pr");
    const body = ciText.split("\n").slice(start, end).join("\n");
    expect(body).not.toContain("secrets.");
    const tests = pr.steps.find((s) => s.run?.includes("test:integration"));
    expect(tests?.env?.LUMENWIPE_ADMIN_KEYS_WITHHELD).toBe("true");
  });

  test("the aggregate needs both funded jobs", () => {
    expect(ci.jobs.ci.needs).toContain("integration-funded");
    expect(ci.jobs.ci.needs).toContain("integration-funded-pr");
  });

  test("ci.yml runs on push and pull_request only, the events the aggregate knows", () => {
    expect(Object.keys(ci.on).sort()).toEqual(["pull_request", "push"]);
  });

  const cases: [string, string, string, number][] = [
    ["push", "success", "skipped", 0],
    ["push", "failure", "skipped", 1],
    ["push", "skipped", "skipped", 1],
    ["push", "cancelled", "skipped", 1],
    ["push", "skipped", "success", 1],
    ["pull_request", "skipped", "success", 0],
    ["pull_request", "skipped", "failure", 1],
    ["pull_request", "skipped", "skipped", 1],
    ["pull_request", "success", "skipped", 1],
    ["pull_request", "success", "success", 1],
    ["workflow_dispatch", "success", "success", 1],
    ["merge_group", "skipped", "success", 1],
    ["", "success", "skipped", 1],
  ];
  for (const [event, funded, fundedPr, code] of cases) {
    test(`the aggregate exits ${code} on ${event || "no event"} with funded ${funded} and PR ${fundedPr}`, () => {
      expect(
        aggregate({ EVENT_NAME: event, FUNDED_RESULT: funded, FUNDED_PR_RESULT: fundedPr })
      ).toBe(code);
    });
  }
});

describe("integration-funded-review.yml", () => {
  test("runs only by hand, and releases the keys only through the review environment", () => {
    expect(Object.keys(review.on)).toEqual(["workflow_dispatch"]);
    const funded = review.jobs.funded;
    expect(funded.environment).toBe("testnet-funded-review");
    expect(funded.needs).toBe("resolve");
    expect(review.jobs.resolve.environment).toBeUndefined();
    const [start, end] = jobLines(reviewText, "funded");
    for (const secret of ADMIN_SECRETS) {
      for (const line of linesNaming(reviewText, secret)) {
        expect(line).toBeGreaterThanOrEqual(start);
        expect(line).toBeLessThan(end);
      }
    }
  });

  test("passes every input through env and never into a script or an action", () => {
    for (const job of Object.values(review.jobs)) {
      for (const step of job.steps) expect(step.run ?? "").not.toContain("${{");
    }
    const inputLines = reviewText.split("\n").filter((line) => line.includes("inputs."));
    expect(inputLines.length).toBeGreaterThan(0);
    for (const line of inputLines) {
      expect(line).toMatch(/^\s+(PR|SHA): \$\{\{ inputs\.(pr|sha) \}\}$/);
    }
  });

  test("checks the reviewed SHA out from the PR's head ref and refuses a moved head", () => {
    const checkout = review.jobs.funded.steps[0];
    expect(checkout.uses).toBeUndefined();
    expect(checkout.run).toContain('"+refs/pull/$PR/head:refs/remotes/pr/head"');
    expect(checkout.run).toContain('if [ "$fetched" != "$SHA" ]; then');
    expect(checkout.run).toContain('git checkout -q --detach "$SHA"');
  });
});

describe("e2e-nightly.yml", () => {
  test("runs on its schedule or by hand, never for a pull request", () => {
    expect(Object.keys(nightly.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
  });

  test("only the playground job, in the testnet-funded environment, names the token admin's key", () => {
    expect(nightly.jobs.playground.environment).toBe("testnet-funded");
    const [start, end] = jobLines(nightlyText, "playground");
    const lines = linesNaming(nightlyText, PLAYGROUND_TOKEN_SECRET);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toBeGreaterThanOrEqual(start);
      expect(line).toBeLessThan(end);
    }
    for (const file of readdirSync(WORKFLOWS).filter((f) => f !== "e2e-nightly.yml")) {
      expect(readFileSync(join(WORKFLOWS, file), "utf8")).not.toContain(PLAYGROUND_TOKEN_SECRET);
    }
  });

  test("the web authentication TTL job holds no secret and takes the contract only from vars through env", () => {
    const job = nightly.jobs["web-auth-ttl"]!;
    expect(job.environment).toBeUndefined();
    expect(job.permissions).toEqual({ contents: "read" });
    const [start, end] = jobLines(nightlyText, "web-auth-ttl");
    const text = nightlyText.split("\n").slice(start, end).join("\n");
    expect(text).not.toContain("secrets.");
    const variable = "${{ vars.INTEGRATOR_WEB_AUTH_CONTRACT_TESTNET }}";
    const naming = job.steps.filter((s) => JSON.stringify(s).includes("vars."));
    expect(naming).toHaveLength(1);
    expect(naming[0]!.env?.INTEGRATOR_WEB_AUTH_CONTRACT_TESTNET).toBe(variable);
    expect(naming[0]!.run).toBe("bun run web-auth:testnet-ttl");
    expect(nightly.jobs.report!.needs).toContain("web-auth-ttl");
  });
});
