import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkAll,
  checkControllerList,
  checkFormatCommand,
  checkPlaygroundImports,
  checkRegister,
  checkSdkDoesNotBundleStellarSdk,
  checkSecurityScope,
  isScopePath,
  checkThreatModelCoverage,
  checkWebBuildsNoTransactions,
  declares,
  expandBraces,
  hasTest,
  stripComments,
} from "./check-docs-claims";

const roots: string[] = [];
const SCRIPT = join(import.meta.dir, "check-docs-claims.ts");

const CLAUDE_MD =
  "Controllers under `src/{close,mediator}`, plus `src/root.controller.ts`.\n" +
  "CI's `prettier` job runs `bun run format:check`.\n";
const WORKFLOW = [
  "on:",
  "  push:",
  "jobs:",
  "  prettier:",
  "    steps:",
  "      - run: bun run format:check",
  "  docs-claims:",
  "    steps: []",
  "",
].join("\n");
const ROW =
  '| INV-01 | x | `apps/web/lib/verify.ts#assertCloseIntent` | `apps/web/tests/unit/verify.test.ts#"rejects an unknown operation"`, `.github/workflows/ci.yml#docs-claims` | Enforced |';

function register(...rows: string[]): string {
  return [
    "| Id | Invariant | Enforced by | Proved by | Status |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function fixture(files: Record<string, string | null>): string {
  const root = mkdtempSync(join(tmpdir(), "docs-claims-"));
  roots.push(root);
  const base: Record<string, string | null> = {
    "CLAUDE.md": CLAUDE_MD,
    ".github/workflows/ci.yml": WORKFLOW,
    "apps/api/src/root.controller.ts": "export class RootController {}\n",
    "apps/api/src/close/close.controller.ts": "export class CloseController {}\n",
    "apps/api/src/mediator/mediator.controller.ts": "export class MediatorController {}\n",
    "apps/api/src/common/fail.ts": "export function fail() {}\n",
    "apps/web/lib/verify.ts":
      'import { TransactionBuilder } from "@stellar/stellar-sdk";\n' +
      "export function assertCloseIntent() {}\n" +
      "const tx = TransactionBuilder.fromXDR(xdr, passphrase);\n",
    "apps/web/tests/unit/verify.test.ts": 'test("rejects an unknown operation", () => {});\n',
    "apps/playground/lib/close.ts": 'import { runClose } from "@lumenwipe/sdk";\n',
    "packages/sdk/package.json": JSON.stringify({
      dependencies: {},
      devDependencies: { "@stellar/stellar-sdk": "17.2.1" },
    }),
    "packages/sdk/src/client.ts": "export class LumenWipeClient {}\n",
    "docs/invariants.mdx": register(ROW),
    "docs/security-scope.md":
      "| Group | `apps/web/lib/verify.ts`, `apps/web/app/(marketing)/page.tsx`, `.github/workflows/ci.yml` |\n\nRun `bun run check:docs` and `security-review`.\n",
    "apps/web/app/(marketing)/page.tsx": "export default function Page() {}\n",
    "docs/threat-model.md":
      "## 12. Coverage cross-reference\n\n| x | `apps/web/tests/unit/{verify}.test.ts` |\n\n## 13. Maintenance\n\n`apps/missing/elsewhere.ts`\n",
  };
  for (const [path, content] of Object.entries({ ...base, ...files })) {
    if (content === null) continue;
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function run(root: string): { code: number; output: string } {
  const result = Bun.spawnSync(["bun", SCRIPT, root]);
  return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a consistent fixture reports nothing", () => {
  expect(checkAll(fixture({}))).toEqual([]);
});

describe("the command", () => {
  test("exits zero on a consistent tree", () => {
    expect(run(fixture({})).code).toBe(0);
  });

  test("exits non-zero and names the claim on each kind of stale tree", () => {
    const stale: Record<string, string | null>[] = [
      { "apps/web/tests/unit/verify.test.ts": null },
      { "apps/web/lib/build.ts": "new TransactionBuilder(account, opts);\n" },
      { "apps/playground/lib/a.ts": 'import x from "@lumenwipe/api/close";\n' },
      { "apps/api/src/stats/stats.controller.ts": "export class StatsController {}\n" },
      { ".github/workflows/ci.yml": WORKFLOW.replace("format:check", "format") },
      { "packages/sdk/src/x.ts": 'import { Keypair } from "@stellar/stellar-sdk";\n' },
      { "docs/threat-model.md": "## 12. Coverage cross-reference\n\n`apps/gone.ts`\n" },
      { "apps/web/app/(marketing)/page.tsx": null },
    ];
    for (const files of stale) {
      const { code, output } = run(fixture(files));
      expect(code).toBe(1);
      expect(output).toContain("documented claim(s) no longer match the code");
    }
  });
});

describe("the invariant register", () => {
  test("deleting a test file the register names is reported", () => {
    const root = fixture({ "apps/web/tests/unit/verify.test.ts": null });
    expect(checkRegister(root)).toEqual([
      {
        source: "docs/invariants.mdx",
        message: "INV-01: apps/web/tests/unit/verify.test.ts does not exist",
      },
    ]);
  });

  test("a renamed test is reported", () => {
    const root = fixture({
      "apps/web/tests/unit/verify.test.ts":
        'test("rejects an unrecognized operation", () => {});\n',
    });
    expect(checkRegister(root)[0]?.message).toBe(
      'INV-01: apps/web/tests/unit/verify.test.ts has no active test named "rejects an unknown operation"'
    );
  });

  test("a skipped test, or a test name left only in a comment, does not count", () => {
    for (const body of [
      'test.skip("rejects an unknown operation", () => {});\n',
      'test.todo("rejects an unknown operation");\n',
      '// test("rejects an unknown operation")\n',
      'const label = "rejects an unknown operation";\n',
    ]) {
      const root = fixture({ "apps/web/tests/unit/verify.test.ts": body });
      expect(checkRegister(root)[0]?.message).toContain("has no active test named");
    }
  });

  test("a symbol that is only mentioned, or only a longer name, is reported", () => {
    for (const body of [
      "export function assertCloseIntentV2() {}\n",
      "// assertCloseIntent moved elsewhere\n",
      "import { assertCloseIntent } from './elsewhere';\nassertCloseIntent();\n",
    ]) {
      const root = fixture({ "apps/web/lib/verify.ts": body });
      expect(checkRegister(root)[0]?.message).toBe(
        "INV-01: apps/web/lib/verify.ts does not declare assertCloseIntent"
      );
    }
  });

  test("a workflow key outside jobs is not a job", () => {
    const row =
      "| INV-01 | x | `apps/web/lib/verify.ts#assertCloseIntent` | `.github/workflows/ci.yml#push` | Enforced |";
    const root = fixture({ "docs/invariants.mdx": register(row) });
    expect(checkRegister(root)[0]?.message).toBe(
      "INV-01: .github/workflows/ci.yml has no job push"
    );
  });

  test("a CI job the workflow lacks is reported", () => {
    const root = fixture({
      ".github/workflows/ci.yml": WORKFLOW.replace("  docs-claims:\n    steps: []\n", ""),
    });
    expect(checkRegister(root)[0]?.message).toBe(
      "INV-01: .github/workflows/ci.yml has no job docs-claims"
    );
  });

  test("a symbol with regex characters is reported, not thrown", () => {
    const row =
      "| INV-01 | x | `apps/web/lib/verify.ts#assert(Close` | `.github/workflows/ci.yml#docs-claims` | Enforced |";
    const root = fixture({ "docs/invariants.mdx": register(row) });
    expect(checkRegister(root)[0]?.message).toBe(
      "INV-01: apps/web/lib/verify.ts does not declare assert(Close"
    );
  });

  test("a malformed reference is reported instead of skipped", () => {
    const row =
      "| INV-01 | x | `verify.ts #assertCloseIntent/x` | `.github/workflows/ci.yml#docs-claims` | Enforced |";
    const root = fixture({ "docs/invariants.mdx": register(row) });
    expect(checkRegister(root)[0]?.message).toContain("is not a reference this check can read");
  });

  test("a row marked Enforced with no test or job is reported", () => {
    const row = "| INV-01 | x | `apps/web/lib/verify.ts#assertCloseIntent` | None | Enforced |";
    const root = fixture({ "docs/invariants.mdx": register(row) });
    expect(checkRegister(root)[0]?.message).toBe(
      "INV-01 is marked Enforced but names no test or job"
    );
  });

  test("an id given to two rows is reported", () => {
    const root = fixture({ "docs/invariants.mdx": register(ROW, ROW.replace("| x |", "| y |")) });
    expect(checkRegister(root)).toEqual([
      { source: "docs/invariants.mdx", message: "INV-01 names more than one row" },
    ]);
  });

  test("a register with no rows, or a missing register, is reported", () => {
    expect(checkRegister(fixture({ "docs/invariants.mdx": register() }))[0]?.message).toBe(
      "the register has no rows"
    );
    expect(checkRegister(fixture({ "docs/invariants.mdx": null }))[0]?.message).toBe(
      "the invariant register is missing"
    );
  });
});

describe("greppable claims", () => {
  test("a web file that builds a transaction is reported, in any of the usual forms", () => {
    const forms = [
      "new TransactionBuilder(account, opts);",
      "new StellarSdk.TransactionBuilder(account, opts);",
      "const t = new\n  TransactionBuilder(account, opts);",
      "TransactionBuilder.cloneFrom(tx);",
      'import { TransactionBuilder as TB } from "@stellar/stellar-sdk";',
      "Operation.payment({ destination, asset, amount });",
      "builder.addOperation(op);",
    ];
    for (const form of forms) {
      const root = fixture({ "apps/web/lib/build.ts": form + "\n" });
      expect(checkWebBuildsNoTransactions(root).length).toBe(1);
    }
  });

  test("parsing, comments, and the web's tests and scripts are not reported", () => {
    const root = fixture({
      "apps/web/lib/parse.ts":
        "const op = Operation.fromXDRObject(raw);\n// never call new TransactionBuilder here\n",
      "apps/web/tests/unit/build.test.ts": "Operation.payment({});\n",
      "apps/web/scripts/setup.ts": "tx.addOperation(op);\n",
    });
    expect(checkWebBuildsNoTransactions(root)).toEqual([]);
  });

  test("a sibling folder that only starts with tests is still checked", () => {
    const root = fixture({ "apps/web/tests-helpers/build.ts": "new TransactionBuilder(a, b);\n" });
    expect(checkWebBuildsNoTransactions(root).map((p) => p.source)).toEqual([
      "apps/web/tests-helpers/build.ts:1",
    ]);
  });

  test("a playground import from the api or web source is reported", () => {
    const root = fixture({
      "apps/playground/lib/a.ts": 'import { plan } from "@lumenwipe/api/close";\n',
      "apps/playground/lib/b.ts": 'import { verify } from "../../web/lib/verify";\n',
      "apps/playground/lib/c.ts":
        'const x = require("../../../apps/api/src/close/close.controller");\n',
      "apps/playground/lib/d.ts": "const y = await import(`../../web/lib/verify`);\n",
      "apps/playground/lib/e.ts": 'export * from "../../api/src/close/close.controller";\n',
    });
    expect(
      checkPlaygroundImports(root)
        .map((p) => p.source)
        .sort()
    ).toEqual([
      "apps/playground/lib/a.ts",
      "apps/playground/lib/b.ts",
      "apps/playground/lib/c.ts",
      "apps/playground/lib/d.ts",
      "apps/playground/lib/e.ts",
    ]);
  });

  test("controllers missing from CLAUDE.md, nested or at the root, are reported", () => {
    const root = fixture({
      "apps/api/src/stats/v2/stats.controller.ts": "export class StatsController {}\n",
      "apps/api/src/extra.controller.ts": "export class ExtraController {}\n",
    });
    expect(checkControllerList(root).map((p) => p.message)).toEqual([
      "apps/api/src/stats has a controller but is not listed",
      "apps/api/src/extra.controller.ts is not listed",
    ]);
  });

  test("a listed controller that does not exist, or a missing api, is reported", () => {
    const root = fixture({
      "apps/api/src/root.controller.ts": null,
      "apps/api/src/mediator/mediator.controller.ts": null,
    });
    expect(checkControllerList(root).map((p) => p.message)).toEqual([
      "lists mediator, which has no controller in apps/api/src",
      "lists src/root.controller.ts, which does not exist",
    ]);
    const noApi = mkdtempSync(join(tmpdir(), "docs-claims-"));
    roots.push(noApi);
    writeFileSync(join(noApi, "CLAUDE.md"), CLAUDE_MD);
    expect(checkControllerList(noApi)[0]?.message).toBe("apps/api/src does not exist");
  });

  test("a format job CI does not define, or a command it does not run, is reported", () => {
    const wrongJob = fixture({ "CLAUDE.md": CLAUDE_MD.replace("`prettier` job", "`format` job") });
    expect(checkFormatCommand(wrongJob)[0]?.message).toBe(
      "names CI job format, which .github/workflows/ci.yml does not define"
    );
    const wrongCommand = fixture({ "CLAUDE.md": CLAUDE_MD.replace("format:check`", "format`") });
    expect(checkFormatCommand(wrongCommand)[0]?.message).toBe(
      "says CI's prettier job runs bun run format, but it does not"
    );
  });

  test("the format command is found in a block scalar or a chained line, and only in its own job", () => {
    const block = WORKFLOW.replace(
      "      - run: bun run format:check",
      "      - run: |\n          bun run format:check"
    );
    expect(checkFormatCommand(fixture({ ".github/workflows/ci.yml": block }))).toEqual([]);
    const chained = WORKFLOW.replace("bun run format:check", "bun run format:check && echo done");
    expect(checkFormatCommand(fixture({ ".github/workflows/ci.yml": chained }))).toEqual([]);
    const elsewhere = WORKFLOW.replace(
      "      - run: bun run format:check",
      "      - run: echo"
    ).replace("    steps: []", "    steps:\n      - run: bun run format:check");
    expect(checkFormatCommand(fixture({ ".github/workflows/ci.yml": elsewhere }))).toHaveLength(1);
  });

  test("an SDK that depends on or imports the Stellar SDK is reported", () => {
    const depends = fixture({
      "packages/sdk/package.json": JSON.stringify({
        dependencies: { "@stellar/stellar-sdk": "17.2.1" },
      }),
    });
    expect(checkSdkDoesNotBundleStellarSdk(depends).map((p) => p.message)).toEqual([
      "lists @stellar/stellar-sdk in dependencies",
    ]);
    const imports = fixture({
      "packages/sdk/src/x.ts": 'import { Keypair } from "@stellar/stellar-sdk";\n',
    });
    expect(checkSdkDoesNotBundleStellarSdk(imports).map((p) => p.source)).toEqual([
      "packages/sdk/src/x.ts",
    ]);
  });

  test("a path cited in the threat model's coverage section that no longer exists is reported", () => {
    const root = fixture({
      "docs/threat-model.md":
        "## 12. Coverage cross-reference\n\n| x | `apps/web/tests/unit/{verify, gone}.test.ts` |\n",
    });
    expect(checkThreatModelCoverage(root).map((p) => p.message)).toEqual([
      "the coverage section cites apps/web/tests/unit/gone.test.ts, which does not exist",
    ]);
  });

  test("an emptied coverage section is reported, and paths outside it are not checked", () => {
    const empty = fixture({
      "docs/threat-model.md": "## 12. Coverage cross-reference\n\nNothing.\n",
    });
    expect(checkThreatModelCoverage(empty)[0]?.message).toBe(
      "the coverage section cites no repository path"
    );
    expect(checkThreatModelCoverage(fixture({}))).toEqual([]);
  });
});

describe("helpers", () => {
  test("brace expansion trims, deduplicates and handles several groups", () => {
    expect(expandBraces("a/{b,c}/{d,e}.ts")).toEqual([
      "a/b/d.ts",
      "a/b/e.ts",
      "a/c/d.ts",
      "a/c/e.ts",
    ]);
    expect(expandBraces("a/{b, b}.ts")).toEqual(["a/b.ts"]);
    expect(expandBraces("a/b.ts")).toEqual(["a/b.ts"]);
  });

  test("comment stripping keeps strings, line numbers, and globs inside strings", () => {
    const source =
      'const glob = "tests/**/*.ts"; // trailing\n/* block\n */ const url = "https://x";\n';
    const stripped = stripComments(source);
    expect(stripped).toContain('"tests/**/*.ts"');
    expect(stripped).toContain('"https://x"');
    expect(stripped).not.toContain("trailing");
    expect(stripped.split("\n")).toHaveLength(source.split("\n").length);
  });

  test("declarations, methods and config rule keys count as declared", () => {
    expect(declares("export class A {}", "A")).toBe(true);
    expect(declares("  async transactions(network) {", "transactions")).toBe(true);
    expect(declares('rules: { "no-restricted-imports": ["error"] }', "no-restricted-imports")).toBe(
      true
    );
    expect(declares("export { a as b, c };", "c")).toBe(true);
    expect(declares("call(A);", "A")).toBe(false);
  });

  test("a test counts only when registered with exactly that name", () => {
    expect(hasTest('it("does x", () => {})', "does x")).toBe(true);
    expect(hasTest("test.only(`does x`, () => {})", "does x")).toBe(true);
    expect(hasTest('test("does x and y", () => {})', "does x")).toBe(false);
  });
});

describe("the security scope", () => {
  const scope = (body: string) => fixture({ "docs/security-scope.md": body });

  test("a path it names that no longer exists is reported, including paths with parentheses", () => {
    const root = fixture({ "apps/web/app/(marketing)/page.tsx": null });
    expect(checkSecurityScope(root)).toEqual([
      {
        source: "docs/security-scope.md",
        message: "names apps/web/app/(marketing)/page.tsx, which does not exist",
      },
    ]);
  });

  test("dotfiles, root files, .github paths and directories are checked", () => {
    const root = scope(
      "`.gitleaks.toml`, `renovate.json`, `.github/workflows/gone.yml`, `apps/web/lib/`, `apps/web/gone/`\n"
    );
    expect(checkSecurityScope(root).map((p) => p.message)).toEqual([
      "names .gitleaks.toml, which does not exist",
      "names renovate.json, which does not exist",
      "names .github/workflows/gone.yml, which does not exist",
      "names apps/web/gone/, which does not exist",
    ]);
  });

  test("dynamic route segments, braces and globs resolve, and a glob that matches nothing is reported", () => {
    const root = fixture({
      "apps/web/app/api/[network]/route.ts": "export function GET() {}\n",
      "docs/security-scope.md":
        "`apps/web/app/api/[network]/route.ts`, `apps/web/lib/{verify}.ts`, `apps/web/lib/ver*.ts`, `apps/web/lib/nothing*.ts`\n",
    });
    expect(checkSecurityScope(root).map((p) => p.message)).toEqual([
      "names apps/web/lib/nothing*.ts, which matches nothing",
    ]);
  });

  test("a path that climbs out of the repository is reported even when it exists", () => {
    expect(checkSecurityScope(scope("`apps/../../etc`\n")).map((p) => p.message)).toEqual([
      "names apps/../../etc, which climbs out of the repository",
    ]);
  });

  test("commands, calls, bare extensions, packages and URLs are not taken for paths", () => {
    for (const span of [
      "bun run check:docs",
      "security-review",
      "verify()",
      "CODEOWNERS",
      ".ts",
      "@lumenwipe/sdk",
      "https://example.com/x",
    ]) {
      expect(isScopePath(span)).toBe(false);
    }
    expect(checkSecurityScope(fixture({}))).toEqual([]);
  });

  test("a scope that names no path, or a missing scope, is reported", () => {
    expect(checkSecurityScope(scope("Nothing here.\n"))[0]?.message).toBe(
      "the security scope names no repository path"
    );
    expect(checkSecurityScope(fixture({ "docs/security-scope.md": null }))[0]?.message).toBe(
      "the security scope is missing"
    );
  });
});
