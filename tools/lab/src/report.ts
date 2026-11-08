import { closeSync, constants, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { assertOutsideCheckout, checkoutRoot } from "./home";
import type { ScenarioResult } from "./measure";
import type { Summary } from "./stats";

const SECRET_SHAPES: readonly RegExp[] = [
  /authorization/i,
  /bearer\s/i,
  /\blw_[A-Za-z0-9_-]{43}/,
  /\blab_[A-Za-z0-9_-]{32}/,
  /\bS[A-Z2-7]{55}\b/,
];

/** Refuses text that carries a header name, a key of a known shape, or any of `secrets`. */
export function assertNoSecrets(text: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    if (secret && text.includes(secret)) throw new Error("refusing to write a secret to disk");
  }
  for (const shape of SECRET_SHAPES) {
    if (shape.test(text)) throw new Error(`refusing to write text matching ${shape}`);
  }
}

const ms = (v: number | null): string => (v === null ? "-" : String(v));

function cells(s: Summary): string[] {
  return [String(s.n), ms(s.p50), ms(s.p95)];
}

export function latencyTable(results: readonly ScenarioResult[]): string {
  const rows = [
    "| Target | Network | Scenario | Rounds x runs | Cold n | Cold p50 | Cold p95 | Warm n | Warm p50 | Warm p95 | Statuses |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of results) {
    const statuses = r.missing
      ? "fixture missing"
      : Object.entries(r.statuses)
          .map(([code, n]) => `${code} x${n}`)
          .join(", ");
    rows.push(
      `| ${r.target} | ${r.network} | ${r.scenario} | ${r.rounds} x ${r.runs} | ${[...cells(r.cold), ...cells(r.warm)].join(" | ")} | ${statuses} |`
    );
  }
  return rows.join("\n");
}

export function spanTable(results: readonly ScenarioResult[]): string {
  const withSpans = results.filter((r) => r.spans);
  if (withSpans.length === 0) return "";
  const rows = [
    "| Network | Scenario | Boot p50 | Upstream | Own | Calls (median per request: count, ms) |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of withSpans) {
    const s = r.spans!;
    const calls = Object.entries(s.upstreams)
      .map(([label, u]) => `${label} ${u.calls}x ${u.ms}`)
      .join("; ");
    rows.push(
      `| ${r.network} | ${r.scenario} | ${ms(r.boot?.p50 ?? null)} | ${s.upstreamMs} | ${s.ownMs} | ${calls || "none"} |`
    );
  }
  return rows.join("\n");
}

export function renderReport(
  meta: Record<string, string>,
  results: readonly ScenarioResult[]
): string {
  const header = Object.entries(meta)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
  const spans = spanTable(results);
  return [
    "# LumenWipe API latency",
    "",
    header,
    "",
    "All times in milliseconds. Cold is the first request of a round, warm the rest.",
    "",
    latencyTable(results),
    ...(spans ? ["", "## Where the time goes (local target)", "", spans] : []),
    "",
  ].join("\n");
}

/** Writes the run's files to `dir`, a new folder outside the checkout, after checking each for
 *  secrets. The folder must not exist yet and each file is created exclusively without following
 *  a symlink, so nothing already there is written through. */
export function writeResults(
  dir: string,
  files: Record<string, string>,
  secrets: readonly string[],
  root = checkoutRoot()
): string[] {
  assertOutsideCheckout(dir, "The results folder", root);
  for (const text of Object.values(files)) assertNoSecrets(text, secrets);
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  mkdirSync(dir, { mode: 0o700 });
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  return Object.entries(files).map(([name, text]) => {
    const path = join(dir, name);
    const fd = openSync(path, flags, 0o600);
    try {
      writeFileSync(fd, text);
    } finally {
      closeSync(fd);
    }
    return path;
  });
}
