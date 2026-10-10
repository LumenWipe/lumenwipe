import { expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");

test("docs/reference/supported.mdx matches the registries, wallet modules and limits it is generated from", async () => {
  const proc = Bun.spawn(["bun", join(ROOT, "scripts/supported-matrix.ts")], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
});
