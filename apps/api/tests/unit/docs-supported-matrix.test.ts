import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  ENDPOINTS_ANCHOR,
  destinationsText,
  endpointsTable,
  environmentTable,
  render,
  templateVariables,
} from "../../../../scripts/supported-matrix";

const ROOT = join(import.meta.dir, "../../../..");

test("the supported matrix, the limits page, the environment reference and the architecture endpoint table match the registries, wallet modules and limits they are generated from", async () => {
  const proc = Bun.spawn(["bun", join(ROOT, "scripts/supported-matrix.ts")], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
});

test("the limits page fails to render without its generated markers", () => {
  expect(() => render("## Limits\n", "docs/integrators/limits.mdx")).toThrow(
    "Missing generated:limits markers in docs/integrators/limits.mdx"
  );
});

test("the public exchange count leaves out testnet-only entries", () => {
  const listed = { name: "Coinbase", address: "G1", requiresMemo: true, memoType: "text" };
  const text = destinationsText({
    lastVerified: "2026-10-10",
    validUntil: "2027-01-08",
    entries: [
      listed,
      { ...listed, address: "G2" },
      { name: "Testnet only", address: "G3", requiresMemo: false, network: "testnet" },
    ],
  });
  expect(text).toStartWith(
    "The exchange registry lists 1 exchanges across 2 deposit addresses: Coinbase."
  );
  expect(text).toContain("Every listed address requires a memo (memo types in the registry: text)");
});

const openapi = JSON.parse(readFileSync(join(ROOT, "docs/api-reference/openapi.json"), "utf8")) as {
  paths: Record<string, Record<string, { summary?: string }>>;
};

test("every endpoint the architecture lists is an operation of the published OpenAPI document", () => {
  const page = readFileSync(join(ROOT, "docs/architecture.md"), "utf8");
  const after = page.slice(page.indexOf(ENDPOINTS_ANCHOR));
  const listed = [...after.matchAll(/^\| `(\w+) (\S+)`/gm)].map((m) => `${m[1]} ${m[2]}`);
  const operations = Object.entries(openapi.paths).flatMap(([path, ops]) =>
    Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`)
  );
  expect(listed).toEqual(operations);
});

test("the endpoint table follows the OpenAPI document and refuses an operation with no summary", () => {
  const table = endpointsTable({
    paths: { "/v1/{network}/x": { get: { summary: "Read x | y." }, parameters: {} } },
  });
  expect(table).toBe(
    "| Endpoint | Purpose |\n| --- | --- |\n| `GET /v1/{network}/x` | Read x \\| y. |"
  );
  expect(() => endpointsTable({ paths: { "/x": { post: {} } } })).toThrow("POST /x has no summary");
  expect(() => endpointsTable({ paths: {} })).toThrow("lists no operations");
});

test("the architecture page fails to render without the sentence its table follows", () => {
  expect(() => render("## 7. The API service\n\n| a |\n", "docs/architecture.md")).toThrow(
    "Missing the sentence the generated table follows in docs/architecture.md"
  );
});

test("the anchored table is replaced in place, and inserted when absent", () => {
  const rendered = render(
    `Intro.\n\n${ENDPOINTS_ANCHOR}\n\n| old |\n| --- |\n\nAfter.\n`,
    "docs/architecture.md"
  );
  expect(rendered).toStartWith(`Intro.\n\n${ENDPOINTS_ANCHOR}\n\n| Endpoint | Purpose |`);
  expect(rendered).toEndWith("|\n\nAfter.\n");
  expect(rendered).not.toContain("| old |");
  const inserted = render(`${ENDPOINTS_ANCHOR}\n\nAfter.\n`, "docs/architecture.md");
  expect(inserted).toEndWith("|\n\nAfter.\n");
});

const facts = { required: "No", secret: false, default: "None", purpose: "p" } as const;

test("template variables are read set or commented out, never from prose", () => {
  expect(
    templateVariables(
      "# Intro\nA=1\n# B=\n#C=true\n# VERCEL_ENV=production and this is unset\nA=2\nD=   # note\n"
    )
  ).toEqual(["A", "B", "C", "D"]);
});

test("a variable an example lists without a classification fails, naming it", () => {
  const templates = { api: "API_KEYS=\nNEW_ONE=\n", web: "", playground: "" };
  const classified = { api: { API_KEYS: facts }, web: {}, playground: {} };
  expect(() => environmentTable(templates, classified)).toThrow(
    "NEW_ONE is in apps/api/.env.example but has no entry in ENVIRONMENT"
  );
});

test("a classification for a variable no example lists fails, naming it", () => {
  const templates = { api: "", web: "", playground: "" };
  const classified = { api: {}, web: { GONE: facts }, playground: {} };
  expect(() => environmentTable(templates, classified)).toThrow(
    "GONE has an entry in ENVIRONMENT but is not in apps/web/.env.example"
  );
});

test("a NEXT_PUBLIC_ variable can never be classified secret", () => {
  const templates = { api: "", web: "NEXT_PUBLIC_X=\n", playground: "" };
  const classified = {
    api: {},
    web: { NEXT_PUBLIC_X: { ...facts, secret: true } },
    playground: {},
  };
  expect(() => environmentTable(templates, classified)).toThrow(
    "NEXT_PUBLIC_X is marked secret, but NEXT_PUBLIC_ values ship in the browser bundle"
  );
});

test("the environment reference renders one row per variable with its app and classification", () => {
  const templates = { api: "API_KEYS=\n", web: "", playground: "API_KEYS=\n" };
  const classified = {
    api: { API_KEYS: { ...facts, required: "Yes", secret: true } },
    web: {},
    playground: { API_KEYS: facts },
  } as const;
  expect(environmentTable(templates, classified).split("\n").slice(2)).toEqual([
    "| `API_KEYS` | api | Yes | Secret | None | p |",
    "| `API_KEYS` | playground | No | Public | None | p |",
  ]);
});
