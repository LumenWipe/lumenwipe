import { expect, test } from "bun:test";
import path from "path";
import { ESLint } from "eslint";

const root = path.join(import.meta.dir, "../..");
const eslint = new ESLint({ cwd: root });

async function errors(code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, {
    filePath: path.join(root, "tests/unit/zz-fixture.test.ts"),
  });
  return result!.messages.filter((m) => m.severity === 2).map((m) => `${m.ruleId}: ${m.message}`);
}

test("a test that casts through unknown fails lint", async () => {
  for (const code of [
    "export const n = 1 as unknown as string;\n",
    "export const n = (globalThis as unknown as { x: number }).x;\n",
  ]) {
    expect(await errors(code)).toEqual([
      expect.stringMatching(/^no-restricted-syntax: Do not cast through unknown in tests/),
    ]);
  }
});

test("a single assertion in a test is allowed", async () => {
  expect(await errors("export const n = 1 as number;\n")).toEqual([]);
});
