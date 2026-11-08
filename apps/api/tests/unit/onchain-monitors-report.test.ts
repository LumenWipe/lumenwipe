import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs the report job's issue step from .github/workflows/onchain-monitors.yml as written, with
// a stub `gh`, to prove which check outcomes open an alert and which read as clean.

const WORKFLOW = new URL("../../../../.github/workflows/onchain-monitors.yml", import.meta.url);

interface Step {
  id?: string;
  run?: string;
}
const workflow = Bun.YAML.parse(readFileSync(WORKFLOW, "utf8")) as {
  jobs: { report: { steps: Step[] } };
};
const script = workflow.jobs.report.steps.find((s) => s.id === "issue")?.run;
if (!script) throw new Error("the report job has no `issue` step");

const dir = mkdtempSync(join(tmpdir(), "monitors-report-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(
  join(dir, "gh"),
  [
    "#!/usr/bin/env bash",
    'echo "$*" >> "$GH_LOG"',
    'case "$1 $2" in',
    '  "issue list") printf "%s" "$GH_EXISTING" ;;',
    '  "issue create") echo "https://github.com/o/r/issues/9" ;;',
    "esac",
  ].join("\n")
);
chmodSync(join(dir, "gh"), 0o755);

interface Outcome {
  outputs: Record<string, string>;
  calls: string[];
}

let run = 0;
async function report(env: Record<string, string>, existing = false): Promise<Outcome> {
  run++;
  const output = join(dir, `output-${run}`);
  const log = join(dir, `gh-${run}`);
  writeFileSync(output, "");
  writeFileSync(log, "");
  const proc = Bun.spawn(["bash", "-c", script as string], {
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      GITHUB_OUTPUT: output,
      GH_LOG: log,
      GH_EXISTING: existing
        ? JSON.stringify([{ number: 7, title: "An on-chain monitor is reporting a finding" }])
        : "[]",
      REPO: "o/r",
      RUN_URL: "https://github.com/o/r/actions/runs/1",
      HOURLY: "true",
      REGISTRY: "skipped",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await proc.exited).toBe(0);
  const outputs: Record<string, string> = {};
  for (const line of readFileSync(output, "utf8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return { outputs, calls: readFileSync(log, "utf8").split("\n").filter(Boolean) };
}

const CLEAN = { CONFIG: "success", KEYS: "success", BALANCES: "success", FORWARD: "success" };
const CHECKS = ["CONFIG", "KEYS", "BALANCES", "FORWARD"] as const;

describe("the on-chain monitors report", () => {
  test("an hourly run with every check clean opens nothing", async () => {
    const { outputs, calls } = await report(CLEAN);
    expect(outputs.alert).toBeUndefined();
    expect(calls.some((c) => c.startsWith("issue create"))).toBe(false);
  });

  test("a clean daily run closes the open issue and posts the recovery", async () => {
    const { outputs, calls } = await report({ ...CLEAN, REGISTRY: "success" }, true);
    expect(outputs.alert).toBe("recovered");
    expect(calls).toContain("issue close 7 --repo o/r --reason completed");
  });

  test.each(
    CHECKS.flatMap((check) =>
      ["failure", "skipped", "cancelled", ""].map((result) => [check, result] as const)
    )
  )("%s reporting %p is a finding, never clean", async (check, result) => {
    const { outputs, calls } = await report({ ...CLEAN, REGISTRY: "success", [check]: result });
    expect(outputs.alert).toBe("finding");
    expect(calls.some((c) => c.startsWith("issue create"))).toBe(true);
    expect(calls.some((c) => c.startsWith("issue close"))).toBe(false);
  });

  test("outputs a job that never started did not set are a finding", async () => {
    const { outputs } = await report({ REGISTRY: "success" });
    expect(outputs.alert).toBe("finding");
    expect(outputs.critical).toBe("no");
  });

  test.each([
    ["KEYS", "failure", "yes"],
    ["FORWARD", "failure", "yes"],
    ["BALANCES", "failure", "no"],
    ["CONFIG", "failure", "no"],
    ["KEYS", "skipped", "no"],
    ["FORWARD", "cancelled", "no"],
  ])("%s %s pages everyone: %s", async (check, result, critical) => {
    const { outputs } = await report({ ...CLEAN, [check]: result });
    expect(outputs.critical).toBe(critical);
  });

  test("a registry that skips or is cancelled is not a finding on its own", async () => {
    for (const registry of ["skipped", "cancelled"]) {
      const { outputs } = await report({ ...CLEAN, REGISTRY: registry }, true);
      expect(outputs.alert).toBeUndefined();
    }
  });
});
