import { expect, test } from "bun:test";
import { join } from "node:path";
import { destinationsText, render } from "../../../../scripts/supported-matrix";

const ROOT = join(import.meta.dir, "../../../..");

test("the supported matrix and the limits page match the registries, wallet modules and limits they are generated from", async () => {
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
