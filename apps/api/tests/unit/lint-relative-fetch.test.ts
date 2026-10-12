import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const API_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const eslint = new ESLint({ cwd: API_ROOT });

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
  expect(await messagesFor('fetch("/x");\n', "tests/unit/lint-fixture.ts")).toHaveLength(1);
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
