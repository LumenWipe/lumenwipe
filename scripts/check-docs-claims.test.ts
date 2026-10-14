import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  checkAll,
  checkControllerList,
  checkFormatCommand,
  checkPlaygroundImports,
  checkRegister,
  checkThreatModelCoverage,
  checkWebBuildsNoTransactions,
  expandBraces,
} from "./check-docs-claims";

const roots: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "docs-claims-"));
  roots.push(root);
  const base: Record<string, string> = {
    "CLAUDE.md":
      "Controllers under `src/{close,mediator}`.\nCI's `prettier` job runs `bun run format:check`.\n",
    ".github/workflows/ci.yml":
      "jobs:\n  prettier:\n    steps:\n      - run: bun run format:check\n  docs-claims:\n    steps: []\n",
    "apps/api/src/close/close.controller.ts": "export class CloseController {}\n",
    "apps/api/src/mediator/mediator.controller.ts": "export class MediatorController {}\n",
    "apps/api/src/common/fail.ts": "export function fail() {}\n",
    "apps/web/lib/verify.ts": "export function assertCloseIntent() {}\n",
    "apps/web/tests/unit/verify.test.ts": 'test("rejects an unknown operation", () => {});\n',
    "apps/playground/lib/close.ts": 'import { runClose } from "@lumenwipe/sdk";\n',
    "docs/invariants.mdx": [
      "| Id | Invariant | Enforced by | Proved by |",
      '| INV-01 | x | `apps/web/lib/verify.ts#assertCloseIntent` | `apps/web/tests/unit/verify.test.ts#"rejects an unknown operation"`, `.github/workflows/ci.yml#docs-claims` |',
    ].join("\n"),
    "docs/threat-model.md":
      "## 12. Coverage cross-reference\n\n| x | `apps/web/tests/unit/{verify}.test.ts` |\n\n## 13. Maintenance\n\n`missing/elsewhere.ts`\n",
  };
  for (const [path, content] of Object.entries({ ...base, ...files })) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a consistent fixture reports nothing", () => {
  expect(checkAll(fixture({}))).toEqual([]);
});

test("the repository itself reports nothing", () => {
  expect(checkAll(resolve(import.meta.dir, ".."))).toEqual([]);
});

describe("the invariant register", () => {
  test("deleting a test file the register names is reported", () => {
    const root = fixture({});
    rmSync(join(root, "apps/web/tests/unit/verify.test.ts"));
    expect(checkRegister(root)).toEqual([
      {
        source: "docs/invariants.mdx",
        message: "apps/web/tests/unit/verify.test.ts does not exist",
      },
    ]);
  });

  test("a renamed test is reported", () => {
    const root = fixture({
      "apps/web/tests/unit/verify.test.ts":
        'test("rejects an unrecognized operation", () => {});\n',
    });
    expect(checkRegister(root)[0]?.message).toContain(
      'has no test named "rejects an unknown operation"'
    );
  });

  test("a renamed symbol is reported, and a longer name containing it does not count", () => {
    const root = fixture({
      "apps/web/lib/verify.ts": "export function assertCloseIntentV2() {}\n",
    });
    expect(checkRegister(root)[0]?.message).toBe(
      "apps/web/lib/verify.ts has no symbol assertCloseIntent"
    );
  });

  test("a CI job the register names but the workflow lacks is reported", () => {
    const root = fixture({
      ".github/workflows/ci.yml":
        "jobs:\n  prettier:\n    steps:\n      - run: bun run format:check\n",
    });
    expect(checkRegister(root)[0]?.message).toBe(".github/workflows/ci.yml has no job docs-claims");
  });

  test("a missing register is reported", () => {
    const root = fixture({});
    rmSync(join(root, "docs/invariants.mdx"));
    expect(checkRegister(root)[0]?.message).toBe("the invariant register is missing");
  });
});

describe("greppable claims", () => {
  test("a web file that builds a transaction is reported", () => {
    const root = fixture({
      "apps/web/lib/build.ts": "const tx = new TransactionBuilder(account, opts);\n",
    });
    expect(checkWebBuildsNoTransactions(root).map((p) => p.source)).toEqual([
      "apps/web/lib/build.ts:1",
    ]);
  });

  test("building a transaction inside the web's tests or scripts is allowed", () => {
    const root = fixture({
      "apps/web/tests/unit/build.test.ts": "Operation.payment({});\n",
      "apps/web/scripts/setup.ts": "tx.addOperation(op);\n",
    });
    expect(checkWebBuildsNoTransactions(root)).toEqual([]);
  });

  test("a playground import from the api or web source is reported", () => {
    const root = fixture({
      "apps/playground/lib/a.ts": 'import { plan } from "@lumenwipe/api/close";\n',
      "apps/playground/lib/b.ts": 'import { verify } from "../../web/lib/verify";\n',
      "apps/playground/lib/c.ts":
        'const x = require("../../../apps/api/src/close/close.controller");\n',
    });
    expect(
      checkPlaygroundImports(root)
        .map((p) => p.source)
        .sort()
    ).toEqual(["apps/playground/lib/a.ts", "apps/playground/lib/b.ts", "apps/playground/lib/c.ts"]);
  });

  test("a controller directory missing from CLAUDE.md, or listed without a controller, is reported", () => {
    const root = fixture({
      "CLAUDE.md":
        "Controllers under `src/{close,stats}`.\nCI's `prettier` job runs `bun run format:check`.\n",
    });
    expect(checkControllerList(root).map((p) => p.message)).toEqual([
      "apps/api/src/mediator has a controller but is not listed",
      "lists stats, which has no controller in apps/api/src",
    ]);
  });

  test("a format job or command that CI does not run is reported", () => {
    const wrongJob = fixture({
      "CLAUDE.md":
        "Controllers under `src/{close,mediator}`.\nCI's `format` job runs `bun run format:check`.\n",
    });
    expect(checkFormatCommand(wrongJob)[0]?.message).toContain("names CI job format");
    const wrongCommand = fixture({
      "CLAUDE.md":
        "Controllers under `src/{close,mediator}`.\nCI's `prettier` job runs `bun run format`.\n",
    });
    expect(checkFormatCommand(wrongCommand)[0]?.message).toContain("does not");
  });

  test("a path cited in the threat model's coverage section that no longer exists is reported", () => {
    const root = fixture({
      "docs/threat-model.md":
        "## 12. Coverage cross-reference\n\n| x | `apps/web/tests/unit/{verify,gone}.test.ts` |\n",
    });
    expect(checkThreatModelCoverage(root).map((p) => p.message)).toEqual([
      "the coverage section cites apps/web/tests/unit/gone.test.ts, which does not exist",
    ]);
  });

  test("paths outside the coverage section are not checked", () => {
    expect(checkThreatModelCoverage(fixture({}))).toEqual([]);
  });
});

test("brace expansion covers nested and multiple groups", () => {
  expect(expandBraces("a/{b,c}/{d,e}.ts")).toEqual([
    "a/b/d.ts",
    "a/b/e.ts",
    "a/c/d.ts",
    "a/c/e.ts",
  ]);
  expect(expandBraces("a/b.ts")).toEqual(["a/b.ts"]);
});
