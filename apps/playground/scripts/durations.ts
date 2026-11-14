// Regenerates lib/scenarios/measured-durations.ts from nightly playground reports.
//
//   gh run download <run id> -n playground-playwright-report -D <dir>
//   bun run durations <run id>=<dir>/<JSON_REPORT_PATH> [<run id>=<path> ...]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { moduleSource, summarize, type PlaywrightReport } from "./durations-report";

const OUT = join(__dirname, "..", "lib", "scenarios", "measured-durations.ts");

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: bun run durations <run id>=<report.json> [...]");
  process.exit(1);
}
const reports = args.map((arg) => {
  const at = arg.indexOf("=");
  if (at <= 0) throw new Error(`Expected <run id>=<report.json>, got ${arg}`);
  const run = arg.slice(0, at);
  if (!/^\d+$/.test(run)) throw new Error(`Not a run id: ${run}`);
  const report = JSON.parse(readFileSync(arg.slice(at + 1), "utf8")) as PlaywrightReport;
  return { run, report };
});

const measured = summarize(reports);
writeFileSync(OUT, moduleSource(measured));
execFileSync(join(__dirname, "..", "..", "..", "node_modules", ".bin", "prettier"), [
  "--write",
  OUT,
]);
console.log(
  `Wrote ${OUT}: ${measured.coverage.inside} of ${measured.coverage.tests} measured tests inside their range`
);
