import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs the report job's issue step from .github/workflows/onchain-monitors.yml as written, with
// a stub `gh`, to prove which check outcomes open an alert and which read as clean.

const WORKFLOW = new URL("../../../../.github/workflows/onchain-monitors.yml", import.meta.url);

interface Step {
  id?: string;
  name?: string;
  run?: string;
}
interface Job {
  if?: string;
  outputs?: Record<string, string>;
  steps: Step[];
}
const source = readFileSync(WORKFLOW, "utf8");
const workflow = Bun.YAML.parse(source) as { jobs: { registry: Job; report: Job } };
const compareScript = workflow.jobs.registry.steps.find((s) => s.id === "compare")?.run;
if (!compareScript) throw new Error("the registry job has no `compare` step");
const script = workflow.jobs.report.steps.find((s) => s.id === "issue")?.run;
if (!script) throw new Error("the report job has no `issue` step");
const alertScript = workflow.jobs.report.steps.find(
  (s) => s.name === "Alert the maintainers' channel"
)?.run;
if (!alertScript) throw new Error("the report job has no alert step");

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
  /** The whole output file, multi-line values included. */
  raw: string;
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
  const raw = readFileSync(output, "utf8");
  const outputs: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return { outputs, raw, calls: readFileSync(log, "utf8").split("\n").filter(Boolean) };
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

  // One row per way a keys or forward step can end: its outcome, the status it wrote (none when
  // it crashed, timed out or never ran), and whether that pages everyone.
  test.each([
    ["KEYS", "failure", "finding", "yes"],
    ["FORWARD", "failure", "finding", "yes"],
    ["KEYS", "failure", "incomplete", "no"],
    ["FORWARD", "failure", "incomplete", "no"],
    ["KEYS", "failure", "", "no"],
    ["FORWARD", "failure", "", "no"],
    ["KEYS", "cancelled", "", "no"],
    ["FORWARD", "cancelled", "", "no"],
    ["KEYS", "skipped", "", "no"],
    ["FORWARD", "", "", "no"],
    ["BALANCES", "failure", "", "no"],
    ["CONFIG", "failure", "", "no"],
  ])("%s %p with status %p pages everyone: %s", async (check, result, status, critical) => {
    const { outputs } = await report({
      ...CLEAN,
      [check]: result,
      ...(status === "" ? {} : { [`${check}_STATUS`]: status }),
    });
    expect(outputs.alert).toBe("finding");
    expect(outputs.critical).toBe(critical);
  });

  test("a finding pages even when the other history check could not read everything", async () => {
    const { outputs } = await report({
      ...CLEAN,
      KEYS: "failure",
      KEYS_STATUS: "incomplete",
      FORWARD: "failure",
      FORWARD_STATUS: "finding",
    });
    expect(outputs.critical).toBe("yes");
  });

  test("the status lines say which failures are findings and which are incomplete reads", async () => {
    const { raw } = await report({
      ...CLEAN,
      KEYS: "failure",
      KEYS_STATUS: "finding",
      FORWARD: "cancelled",
    });
    expect(raw).toContain("- service keys have not signed anything: failure (finding)\n");
    expect(raw).toContain(
      "- no service account paid out beyond the forward and the drain: cancelled (incomplete)\n"
    );
    expect(raw).toContain("- service accounts are above their balance floor: success\n");
  });

  test("a failed step that wrote no status reads as incomplete, not clean or critical", async () => {
    const { outputs, raw } = await report({ ...CLEAN, KEYS: "failure", FORWARD: "failure" });
    expect(raw).toContain("- service keys have not signed anything: failure (incomplete)\n");
    expect(raw).toContain(
      "- no service account paid out beyond the forward and the drain: failure (incomplete)\n"
    );
    expect(outputs.alert).toBe("finding");
    expect(outputs.critical).toBe("no");
  });

  test("an hourly incomplete read on an open issue neither alerts nor comments again", async () => {
    const { outputs, calls } = await report(
      { ...CLEAN, KEYS: "failure", KEYS_STATUS: "incomplete" },
      true
    );
    expect(outputs.alert).toBeUndefined();
    expect(outputs.issue).toBe("7");
    expect(calls.some((c) => c.startsWith("issue comment"))).toBe(false);
    expect(calls.some((c) => c.startsWith("issue close"))).toBe(false);
  });

  test("a daily incomplete read on an open issue comments without alerting", async () => {
    const { outputs, calls } = await report(
      {
        ...CLEAN,
        REGISTRY: "success",
        HOURLY: "false",
        FORWARD: "failure",
        FORWARD_STATUS: "incomplete",
      },
      true
    );
    expect(outputs.alert).toBeUndefined();
    expect(calls.some((c) => c.startsWith("issue comment 7"))).toBe(true);
    expect(calls.some((c) => c.startsWith("issue close"))).toBe(false);
  });

  test("an hourly finding on an open issue alerts again", async () => {
    const { outputs } = await report({ ...CLEAN, KEYS: "failure", KEYS_STATUS: "finding" }, true);
    expect(outputs.alert).toBe("finding");
    expect(outputs.critical).toBe("yes");
  });

  test("a registry that skips or is cancelled is not a finding on its own", async () => {
    for (const registry of ["skipped", "cancelled"]) {
      const { outputs, calls } = await report({ ...CLEAN, REGISTRY: registry }, true);
      expect(outputs.alert).toBeUndefined();
      expect(calls.some((c) => c.startsWith("issue close"))).toBe(false);
    }
  });

  test("a clean hourly run that compared the registry closes the open issue", async () => {
    const { outputs, calls } = await report({ ...CLEAN, REGISTRY: "success" }, true);
    expect(outputs.alert).toBe("recovered");
    expect(calls).toContain("issue close 7 --repo o/r --reason completed");
  });

  test("a clean registry prints no status, even a stale one", async () => {
    const { raw } = await report({
      ...CLEAN,
      REGISTRY: "success",
      REGISTRY_STATUS: "incomplete",
      BALANCES: "failure",
    });
    expect(raw).toContain("- registry hashes still match mainnet: success\n");
  });

  // One row per way a failed registry comparison can end: the status it wrote (none when it
  // crashed or timed out) and the line the issue and the alert carry. None pages everyone.
  test.each([
    ["finding", "failure (finding)"],
    ["incomplete", "failure (incomplete)"],
    ["", "failure (incomplete)"],
  ])("a failed registry with status %p opens the issue once as %p", async (status, line) => {
    const env = {
      ...CLEAN,
      REGISTRY: "failure",
      ...(status === "" ? {} : { REGISTRY_STATUS: status }),
    };
    const opened = await report(env);
    expect(opened.outputs.alert).toBe("finding");
    expect(opened.outputs.critical).toBe("no");
    expect(opened.raw).toContain(`- registry hashes still match mainnet: ${line}\n`);
    expect(opened.calls.some((c) => c.startsWith("issue create"))).toBe(true);

    const hourly = await report(env, true);
    expect(hourly.outputs.alert).toBeUndefined();
    expect(hourly.outputs.issue).toBe("7");
    expect(hourly.calls.some((c) => c.startsWith("issue comment"))).toBe(false);
    expect(hourly.calls.some((c) => c.startsWith("issue close"))).toBe(false);

    const daily = await report({ ...env, HOURLY: "false" }, true);
    expect(daily.outputs.alert).toBeUndefined();
    expect(daily.calls.some((c) => c.startsWith("issue comment 7"))).toBe(true);
    expect(daily.calls.some((c) => c.startsWith("issue close"))).toBe(false);
  });

  test("a registry incomplete read does not mute a key finding in the same run", async () => {
    const { outputs } = await report(
      {
        ...CLEAN,
        REGISTRY: "failure",
        REGISTRY_STATUS: "incomplete",
        KEYS: "failure",
        KEYS_STATUS: "finding",
      },
      true
    );
    expect(outputs.alert).toBe("finding");
    expect(outputs.critical).toBe("yes");
  });

  test("the issue body says what a registry incomplete read is and when the issue closes", async () => {
    const { calls } = await report({ ...CLEAN, REGISTRY: "failure" });
    const create = calls.join("\n");
    expect(create).toContain("A registry incomplete read means the RPC did not answer");
    expect(create).toContain("closes itself on the next run in which every check");
  });
});

describe("the on-chain monitors schedule", () => {
  const crons = [...source.matchAll(/^\s*- cron: "([^"]+)"$/gm)].map((m) => m[1]);

  test("the two schedules cover every hour between them", () => {
    expect(crons).toEqual(["0 0-5,7-23 * * *", "0 6 * * *"]);
  });

  test("the registry comparison runs on every event", () => {
    expect(workflow.jobs.registry.if).toBeUndefined();
  });

  test("the schedule the report compares against is one the workflow runs on", () => {
    const compared = [...source.matchAll(/github\.event\.schedule == '([^']+)'/g)].map((m) => m[1]);
    expect(compared).toEqual([crons[0]]);
  });

  test("the report reads the status the comparison step wrote", () => {
    expect(workflow.jobs.registry.outputs?.status).toBe("${{ steps.compare.outputs.status }}");
    expect(source).toContain("REGISTRY_STATUS: ${{ needs.registry.outputs.status }}");
  });
});

describe("the registry comparison step", () => {
  // Stubs for `bun`, `sleep` and `timeout`: each `bun` call takes the next scripted line, an exit
  // code and the status that run's tests write, so the step's own retry rule is what is proven.
  const binDir = mkdtempSync(join(tmpdir(), "monitors-compare-"));
  afterAll(() => rmSync(binDir, { recursive: true, force: true }));
  const stub = (name: string, lines: string[]): void => {
    writeFileSync(join(binDir, name), ["#!/usr/bin/env bash", ...lines].join("\n"));
    chmodSync(join(binDir, name), 0o755);
  };
  stub("bun", [
    'echo "bun $*" >> "$CALLS"',
    'line=$(head -n 1 "$RUNS")',
    'tail -n +2 "$RUNS" > "$RUNS.rest" && mv "$RUNS.rest" "$RUNS"',
    'if [ -n "${line#*:}" ]; then printf "%s" "${line#*:}" > "$REGISTRY_STATUS_FILE"; fi',
    'exit "${line%%:*}"',
  ]);
  stub("sleep", ['echo "sleep $*" >> "$CALLS"']);
  stub("timeout", ['echo "timeout $1" >> "$CALLS"', "shift", 'exec "$@"']);

  let attempt = 0;
  async function compare(
    runs: string[],
    prefix = ""
  ): Promise<{ code: number; status: string | undefined; calls: string[] }> {
    attempt++;
    const output = join(binDir, `output-${attempt}`);
    const calls = join(binDir, `calls-${attempt}`);
    const scripted = join(binDir, `runs-${attempt}`);
    writeFileSync(output, "");
    writeFileSync(calls, "");
    writeFileSync(scripted, runs.join("\n") + "\n");
    const proc = Bun.spawn(["bash", "-e", "-c", prefix + (compareScript as string)], {
      env: {
        PATH: `${binDir}:${process.env.PATH}`,
        GITHUB_OUTPUT: output,
        REGISTRY_STATUS_FILE: join(binDir, `status-${attempt}`),
        CALLS: calls,
        RUNS: scripted,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    const written = readFileSync(output, "utf8");
    return {
      code,
      status: written === "" ? undefined : written.trim(),
      calls: readFileSync(calls, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((c) => c.split(" ")[0] as string),
    };
  }

  test("a clean comparison runs once and writes no status", async () => {
    expect(await compare(["0:"])).toEqual({ code: 0, status: undefined, calls: ["bun"] });
  });

  test("an incomplete read then a clean run succeeds, with no stale status", async () => {
    expect(await compare(["1:incomplete", "0:"])).toEqual({
      code: 0,
      status: undefined,
      calls: ["bun", "sleep", "timeout", "bun"],
    });
  });

  test("an incomplete read twice fails as incomplete", async () => {
    expect(await compare(["1:incomplete", "1:incomplete"])).toEqual({
      code: 1,
      status: "status=incomplete",
      calls: ["bun", "sleep", "timeout", "bun"],
    });
  });

  test("a finding fails at once, with no second run", async () => {
    expect(await compare(["1:finding", "0:"])).toEqual({
      code: 1,
      status: "status=finding",
      calls: ["bun"],
    });
  });

  test("an incomplete read then a finding fails as the finding", async () => {
    const result = await compare(["1:incomplete", "1:finding"]);
    expect(result.code).toBe(1);
    expect(result.status).toBe("status=finding");
  });

  test("a second run that is killed leaves no status, not the first run's", async () => {
    const result = await compare(["1:incomplete", "124:"]);
    expect(result.code).toBe(124);
    expect(result.status).toBe("status=");
  });

  test("a failure that wrote no status is not retried", async () => {
    expect(await compare(["1:"])).toEqual({ code: 1, status: "status=", calls: ["bun"] });
  });

  test("an incomplete read after a slow first run is not retried", async () => {
    // The shell's own clock, moved past the limit that keeps both runs inside the job timeout.
    expect(await compare(["1:incomplete", "0:"], "SECONDS=120\n")).toEqual({
      code: 1,
      status: "status=incomplete",
      calls: ["bun"],
    });
  });
});

describe("the on-chain monitors alert", () => {
  // A stub `curl` that keeps the payload and answers like Discord.
  const curlDir = mkdtempSync(join(tmpdir(), "monitors-alert-"));
  afterAll(() => rmSync(curlDir, { recursive: true, force: true }));
  writeFileSync(
    join(curlDir, "curl"),
    ["#!/usr/bin/env bash", 'cat > "$CURL_BODY"', "printf 204"].join("\n")
  );
  chmodSync(join(curlDir, "curl"), 0o755);

  async function alert(critical: string) {
    const body = join(curlDir, `body-${critical}`);
    const proc = Bun.spawn(["bash", "-c", alertScript as string], {
      env: {
        PATH: `${curlDir}:${process.env.PATH}`,
        CURL_BODY: body,
        WEBHOOK: "https://discord.invalid/hook",
        ALERT: "finding",
        CRITICAL: critical,
        STATUS: "- service keys have not signed anything: failure (incomplete)",
        ISSUE_URL: "https://github.com/o/r/issues/7",
        RUN_URL: "https://github.com/o/r/actions/runs/1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    return JSON.parse(readFileSync(body, "utf8")) as {
      content: string;
      allowed_mentions: { parse: string[] };
    };
  }

  test("a finding mentions everyone", async () => {
    const payload = await alert("yes");
    expect(payload.content.startsWith("@everyone ")).toBe(true);
    expect(payload.allowed_mentions.parse).toEqual(["everyone"]);
  });

  test("an incomplete read alerts without the mention", async () => {
    const payload = await alert("no");
    expect(payload.content).not.toContain("@everyone");
    expect(payload.allowed_mentions.parse).toEqual([]);
  });
});
