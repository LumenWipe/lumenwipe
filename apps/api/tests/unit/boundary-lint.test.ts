import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const API_ROOT = fileURLToPath(new URL("../../", import.meta.url));
// The same fixture paths as lint-relative-fetch.test.ts: the project service keeps the first
// allowDefaultProject list it is given for the whole `bun test` process.
const FIXTURES = ["src/lint-fixture.ts", "tests/unit/lint-fixture.ts"];
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

async function importErrors(specifier: string, file: string): Promise<string[]> {
  const code = `import { x } from "${specifier}";\nexport const y = x;\n`;
  const [result] = await eslint.lintText(code, { filePath: join(API_ROOT, file) });
  expect(result!.messages.filter((m) => m.ruleId === null)).toEqual([]);
  return result!.messages.filter((m) => m.ruleId === "no-restricted-imports").map((m) => m.message);
}

const CROSS_APP = [
  "../../web/lib/stellar/verify",
  "../../../playground/lib/verify",
  "../../../../apps/web/lib/stellar/verify",
  "../../web",
  "@lumenwipe/web/lib/stellar/verify",
  "@lumenwipe/playground",
];

test("an import of apps/web or apps/playground fails lint in src and tests", async () => {
  for (const file of FIXTURES) {
    for (const specifier of CROSS_APP) {
      expect({ specifier, file, errors: await importErrors(specifier, file) }).toMatchObject({
        errors: [expect.stringMatching(/apps\/api must not import/)],
      });
    }
  }
});

test("the API's own modules and shared packages are allowed", async () => {
  for (const specifier of [
    "@/lib/stellar/submit",
    "./config/networks",
    "./fixtures/web-like-name",
    "../../src/lib/webhooks",
    "@lumenwipe/types",
    "@stellar/stellar-sdk",
  ]) {
    expect({ specifier, errors: await importErrors(specifier, FIXTURES[0]!) }).toEqual({
      specifier,
      errors: [],
    });
  }
});

test("apps/api has no folder named web or playground for a relative path to land in", () => {
  const folders = (dir: string): string[] =>
    readdirSync(join(API_ROOT, dir), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "node_modules" && d.name !== "dist")
      .flatMap((d) => [d.name, ...folders(join(dir, d.name))]);
  const names = folders(".").map((path) => path.split("/").at(-1));
  expect(names).not.toContain("web");
  expect(names).not.toContain("playground");
});
