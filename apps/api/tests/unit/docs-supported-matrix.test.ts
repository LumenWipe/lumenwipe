import { expect, test } from "bun:test";
import { join } from "node:path";
import { render } from "../../../../scripts/supported-matrix";

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
