import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const RETRY_VALUES = ["Yes", "After fix", "Check first", "No"];

const CODES_SOURCE = "apps/api/src/common/error-codes.ts";
const INTRO_PAGE = "docs/api-reference/introduction.mdx";
const ERRORS_PAGE = "docs/api-reference/errors.mdx";
const TABLE_START = "error-codes:start";
const TABLE_END = "error-codes:end";

export function parseRegistry(source) {
  const start = source.indexOf("ERROR_CODES = [");
  const end = source.indexOf("] as const", start);
  if (start === -1 || end === -1) throw new Error(`${CODES_SOURCE} has no ERROR_CODES list`);
  return [...source.slice(start, end).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

function tableRows(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    rows.push({ code: cells[0].replace(/`/g, ""), cells });
  }
  return rows;
}

export function parseGeneratedTable(intro) {
  const start = intro.indexOf(TABLE_START);
  const end = intro.indexOf(TABLE_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${INTRO_PAGE} is missing the ${TABLE_START} markers`);
  }
  return new Map(tableRows(intro.slice(start, end)).map((r) => [r.code, r.cells]));
}

export function checkErrorReference({ codesSource, introPage, errorsPage }) {
  const problems = [];
  const registry = parseRegistry(codesSource);
  const generated = parseGeneratedTable(introPage);
  const rows = tableRows(errorsPage);
  const listed = new Map();

  for (const row of rows) {
    if (listed.has(row.code)) problems.push(`${row.code} is listed more than once`);
    listed.set(row.code, row.cells);
    if (!registry.includes(row.code)) {
      problems.push(`${row.code} is listed but is not in the API's error registry`);
      continue;
    }
    const [, status, retry, meaning] = row.cells;
    if (row.cells.length !== 4) {
      problems.push(`${row.code} must have the columns Code, Status, Retry, Meaning`);
      continue;
    }
    if (!RETRY_VALUES.includes(retry)) {
      problems.push(`${row.code} has Retry "${retry}"; use one of ${RETRY_VALUES.join(", ")}`);
    }
    const source = generated.get(row.code);
    if (source && status !== source[1]) {
      problems.push(`${row.code} has status ${status} but the generated table says ${source[1]}`);
    }
    if (source && meaning !== source[2]) {
      problems.push(`${row.code} has a meaning that differs from the generated table`);
    }
  }

  for (const code of registry) {
    if (!listed.has(code)) problems.push(`${code} is in the API's error registry but has no row`);
  }
  return problems;
}

function main() {
  const root = process.argv[2] ?? ".";
  const read = (path) => readFileSync(join(root, path), "utf8");
  const problems = checkErrorReference({
    codesSource: read(CODES_SOURCE),
    introPage: read(INTRO_PAGE),
    errorsPage: read(ERRORS_PAGE),
  });
  for (const problem of problems) console.error(`::error file=${ERRORS_PAGE}::${problem}`);
  process.exit(problems.length > 0 ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
