import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const API_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURES = ["src/lint-fixture.ts", "tests/unit/lint-fixture.ts"];
// The fixtures exist only as linted text, so the type-aware rules read them through the API's
// own tsconfig instead of a project that would have to find them on disk.
const eslint = new ESLint({
  cwd: API_ROOT,
  overrideConfig: {
    files: FIXTURES,
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: FIXTURES, defaultProject: "tsconfig.json" },
      },
    },
  },
});

async function messagesFor(code: string, file = "src/lint-fixture.ts"): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${API_ROOT}${file}` });
  return result!.messages.map((m) => `${m.ruleId}: ${m.message}`);
}

test("a global fetch with a relative string URL is rejected", async () => {
  const messages = await messagesFor('export const r = () => fetch("/api/testnet/account/x");\n');
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain("no-restricted-syntax");
  expect(messages[0]).toContain("Invalid URL");
});

test("a global fetch with a relative template URL is rejected", async () => {
  const code = "export const r = (n: string) => fetch(`/api/${n}/mediator/sign`);\n";
  expect(await messagesFor(code)).toHaveLength(1);
});

test("the rule also applies to tests", async () => {
  const code = 'export const r = () => fetch("/x");\n';
  expect(await messagesFor(code, "tests/unit/lint-fixture.ts")).toHaveLength(1);
});

test("absolute, computed and injected fetch calls are allowed", async () => {
  const code = [
    'export const a = () => fetch("https://example.com/x");',
    "export const b = (u: string) => fetch(u);",
    "export const c = (base: string) => fetch(`${base}/x`);",
    'export const d = (deps: { fetch: typeof fetch }) => deps.fetch("/x");',
    "",
  ].join("\n");
  expect(await messagesFor(code)).toEqual([]);
});

test("the mock.module ban still fires in tests", async () => {
  const messages = await messagesFor(
    'mock.module("x", () => ({}));\n',
    "tests/unit/lint-fixture.ts"
  );
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain("mock.module replaces a module");
});

test("a promise left floating is rejected in src and tests", async () => {
  const code = 'export function r(): void {\n  fetch("https://example.com/x");\n}\n';
  for (const file of FIXTURES) {
    const messages = await messagesFor(code, file);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("@typescript-eslint/no-floating-promises");
  }
  const handled =
    'export async function r(): Promise<void> {\n  await fetch("https://example.com/x");\n}\n';
  expect(await messagesFor(handled)).toEqual([]);
});

test("an object literal asserted to a type is rejected in src and tests", async () => {
  const code = "interface P {\n  a: number;\n}\nexport const p = { a: 1 } as P;\n";
  for (const file of FIXTURES) {
    const messages = await messagesFor(code, file);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("@typescript-eslint/consistent-type-assertions");
  }
  const annotated = "interface P {\n  a: number;\n}\nexport const p: P = { a: 1 };\n";
  expect(await messagesFor(annotated)).toEqual([]);
});
