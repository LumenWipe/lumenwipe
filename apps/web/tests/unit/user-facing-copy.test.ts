import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { findBannedWords } from "@/lib/glossary";

const WEB_ROOT = join(import.meta.dir, "..", "..");
const SCAN_DIRS = ["app", "components"];

const ALLOWED_LITERALS: ReadonlyArray<{ text: string; reason: string; exact?: boolean }> = [
  {
    text: "The piece the original demolisher lacks.",
    reason: "names a third-party tool in a comparison",
  },
  { text: "Wipe", exact: true, reason: "second half of the LumenWipe wordmark split across JSX" },
];

interface Violation {
  line: number;
  word: string;
  text: string;
}

const NON_COPY_PARENTS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ImportDeclaration,
  ts.SyntaxKind.ExportDeclaration,
  ts.SyntaxKind.LiteralType,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.ExternalModuleReference,
]);

function isNonCopy(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (NON_COPY_PARENTS.has(parent.kind)) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true;
  if (ts.isCallExpression(parent) && parent.expression.getText() === "fetch") return true;
  if (ts.isTemplateSpan(parent) || ts.isTemplateExpression(parent)) {
    const call = (ts.isTemplateSpan(parent) ? parent.parent : parent).parent;
    return ts.isCallExpression(call) && call.expression.getText() === "fetch";
  }
  return false;
}

export function scanSource(source: string, fileName = "file.tsx"): Violation[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Violation[] = [];

  const check = (node: ts.Node, text: string): void => {
    if (ALLOWED_LITERALS.some((a) => (a.exact ? text.trim() === a.text : text.includes(a.text))))
      return;
    for (const word of findBannedWords(text)) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      out.push({ line: line + 1, word, text: text.trim().slice(0, 80) });
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isNonCopy(node)) check(node, node.text);
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      if (!isNonCopy(node)) check(node, node.text);
    } else if (ts.isJsxText(node)) {
      check(node, node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function listSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      return relative(WEB_ROOT, full) === join("app", "api") ? [] : listSources(full);
    }
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("user-facing copy follows the glossary", () => {
  test("no banned word in string literals or JSX text under app and components", () => {
    const found: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of listSources(join(WEB_ROOT, dir))) {
        for (const v of scanSource(readFileSync(file, "utf8"), file)) {
          found.push(`${relative(WEB_ROOT, file)}:${v.line} "${v.word}" in "${v.text}"`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  test("allowlist entries each carry a reason", () => {
    for (const a of ALLOWED_LITERALS) expect(a.reason.length).toBeGreaterThan(0);
  });
});

describe("scanSource", () => {
  test("flags a banned word in a string literal", () => {
    expect(scanSource(`const a = "the wind-down";`).map((v) => v.word)).toEqual(["wind-down"]);
  });

  test("flags a banned word in JSX text and attributes", () => {
    expect(scanSource(`const a = <p>via mediator</p>;`).map((v) => v.word)).toEqual(["mediator"]);
    expect(scanSource(`const a = <i aria-label="intermediary" />;`)).toHaveLength(1);
  });

  test("flags a banned word in a template literal", () => {
    expect(scanSource("const a = `via ${x} intermediary`;")).toHaveLength(1);
  });

  test("ignores identifiers, comments, imports, fetch URLs and the brand", () => {
    const src = [
      `import { useDemolishStore } from "@/store/demolish";`,
      `// the mediator wipes it`,
      `const mediatorRequired = true;`,
      "fetch(`/api/${n}/mediator/check`);",
      `const brand = "LumenWipe";`,
    ].join("\n");
    expect(scanSource(src)).toEqual([]);
  });
});
