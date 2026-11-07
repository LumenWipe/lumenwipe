import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "typescript";
import { destinationRefusal } from "@/lib/plan/destination-check";
import type { Network } from "@/config/networks";

const WEB_ROOT = join(import.meta.dir, "..", "..");
const SCAN_DIRS = ["app", "components", "hooks", "lib", "store"];
const GATE = "lib/plan/destination-check.ts";
const PATHS_ROUTE = "app/api/[network]/paths/route.ts";
const CHECK_ROUTE = "app/api/[network]/mediator/check/[address]/route.ts";
const SIGNING_ROOTS = [
  "lib/stellar/verify.ts",
  "hooks/useCloseExecution.ts",
  "lib/api/close-decisions.ts",
  "app/[network]/review/page.tsx",
  "app/[network]/execute/page.tsx",
];

/**
 * Every fetch the web makes outside its own route handlers. Only the destination check is
 * cached, and its one reader is the gate, which can return nothing but a refusal.
 */
const FETCH_TARGETS: Record<string, "no-store" | "cached, gate only" | "display only"> = {
  "/api/*/account/*": "no-store",
  "/api/*/allowances/*": "no-store",
  "/api/*/allowances/revoke": "no-store",
  "/api/*/fee-bump/sponsor": "no-store",
  "/api/*/mediator/check/*": "cached, gate only",
  "/api/*/mediator/sign": "no-store",
  "/api/integrator/*": "no-store",
  "/api/stats": "display only",
  "/api/stats/feed": "display only",
  "/api/v1/*/close/delivered?*": "display only",
  "/api/v1/*/close/plan": "no-store",
  "/api/v1/*/close/transactions": "no-store",
  "/api/v1/*/submit": "no-store",
  "/api/v1/*/transactions/*": "no-store",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const FILES = SCAN_DIRS.flatMap((dir) => sourceFiles(join(WEB_ROOT, dir))).map((path) =>
  relative(WEB_ROOT, path)
);
const read = (file: string): string => readFileSync(join(WEB_ROOT, file), "utf8");

function codeOf(file: string): string {
  return new Bun.Transpiler({ loader: "tsx" }).transformSync(read(file));
}

function readersOf(names: string[]): string[] {
  return FILES.filter((file) => names.some((name) => codeOf(file).includes(name)));
}

function fetchTargets(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    read(file),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const targets: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "fetch"
    ) {
      targets.push(templateOf(node.arguments[0]));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return targets;
}

function templateOf(arg: ts.Expression): string {
  if (ts.isStringLiteralLike(arg)) return arg.text;
  if (ts.isTemplateExpression(arg)) {
    return [arg.head.text, ...arg.templateSpans.map((s) => `*${s.literal.text}`)].join("");
  }
  return `computed: ${arg.getText()}`;
}

function resolveImport(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? join(WEB_ROOT, specifier.slice(2))
    : specifier.startsWith(".")
      ? join(WEB_ROOT, dirname(from), specifier)
      : null;
  if (base === null) return null;
  const candidates = [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  const hit = candidates.find((path) => existsSync(path));
  return hit ? relative(WEB_ROOT, hit) : null;
}

function reachableFrom(roots: string[]): Set<string> {
  const scanner = new Bun.Transpiler({ loader: "tsx" });
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { path } of scanner.scanImports(read(file))) {
      const next = resolveImport(file, path);
      if (next !== null) queue.push(next);
    }
  }
  return seen;
}

test("only the proxy route names the paths response", () => {
  expect(readersOf(["/paths", "getPaths("])).toEqual([PATHS_ROUTE]);
});

test("only the gate and its route read the destination check", () => {
  expect(readersOf(["mediator/check", "mediatorCheck("]).sort()).toEqual(
    [GATE, CHECK_ROUTE].sort()
  );
});

test("every browser fetch target is classified", () => {
  const unclassified = FILES.filter((file) => !file.startsWith("app/api/"))
    .filter((file) => !read(file).includes('"server-only"'))
    .flatMap((file) => fetchTargets(file).map((target) => ({ file, target })))
    .filter(({ target }) => !(target in FETCH_TARGETS))
    .filter(({ file, target }) => !isRegistryInjection(file, target))
    .map(
      ({ file, target }) =>
        `${file} fetches "${target}". Add it to FETCH_TARGETS in this test with its class, or use a literal URL if it is computed. A cached route may only be read through a gate that returns a refusal.`
    );
  expect(unclassified).toEqual([]);
});

function isRegistryInjection(file: string, target: string): boolean {
  return file === "lib/exchange-registry/index.ts" && target === "computed: input";
}

test("the signing path cannot reach the gate", () => {
  const reachable = reachableFrom(SIGNING_ROOTS);
  expect(reachable.has("lib/stellar/verify.ts")).toBe(true);
  expect(reachable.size).toBeGreaterThan(SIGNING_ROOTS.length);
  expect(reachable.has(GATE)).toBe(false);
});

test("the signing path cannot reach the amount received", () => {
  const reachable = reachableFrom(SIGNING_ROOTS);
  expect(reachable.has("lib/stellar/verify.ts")).toBe(true);
  for (const display of [
    "lib/receipt/received.ts",
    "lib/api/delivered-client.ts",
    "hooks/useReceivedLumens.ts",
  ]) {
    expect(existsSync(join(WEB_ROOT, display))).toBe(true);
    expect(reachable.has(display)).toBe(false);
  }
});

test("the gate returns only a refusal", () => {
  const typed: (n: Network, d: string, m: string) => Promise<string | null> = destinationRefusal;
  expect(typed).toBe(destinationRefusal);

  const source = ts.createSourceFile(GATE, read(GATE), ts.ScriptTarget.Latest, true);
  const exported = source.statements.filter((s) =>
    ts.getModifiers(s as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
  expect(exported.length).toBe(1);
  const gate = exported[0] as ts.FunctionDeclaration;
  expect(gate.name?.text).toBe("destinationRefusal");
  expect(gate.type?.getText()).toBe("Promise<string | null>");
});
