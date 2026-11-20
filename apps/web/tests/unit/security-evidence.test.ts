import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { SECURITY } from "@/lib/i18n/messages/security";
import {
  FEE_EVIDENCE,
  GUARANTEE_EVIDENCE,
  repoFileUrl,
  type Evidence,
} from "@/lib/site/security-evidence";
import { REPO_URL } from "@/lib/site/trust";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const SAFE_PATH = /^(?:[A-Za-z0-9_.()-]+\/)*[A-Za-z0-9_.-]+\.[a-z]+$/;
const TEST_PATH = /(?:^|\/)tests?\/|\.test\.tsx?$/;

const ALL: [string, Evidence][] = [
  ...Object.entries(GUARANTEE_EVIDENCE).map(([id, e]): [string, Evidence] => [
    `guarantee ${id}`,
    e,
  ]),
  ...Object.entries(FEE_EVIDENCE).map(([id, e]): [string, Evidence] => [`fee ${id}`, e]),
];

/** The paths in `evidence` that are not a file in the repository. */
function missing(evidence: Evidence, root = ROOT): string[] {
  return [...evidence.code, ...evidence.tests].filter((path) => {
    const full = join(root, path);
    return !existsSync(full) || !statSync(full).isFile();
  });
}

describe("the security page's evidence links", () => {
  test("cover every guarantee the page states, in both languages", () => {
    for (const locale of ["en", "es"] as const) {
      expect(Object.keys(GUARANTEE_EVIDENCE).sort()).toEqual(
        Object.keys(SECURITY[locale].guarantees).sort()
      );
      expect(Object.keys(FEE_EVIDENCE).sort()).toEqual(
        Object.keys(SECURITY[locale].fees.labels).sort()
      );
    }
  });

  for (const [name, evidence] of ALL) {
    describe(name, () => {
      test("links at least one file that enforces it and one test", () => {
        expect(evidence.code.length).toBeGreaterThan(0);
        expect(evidence.tests.length).toBeGreaterThan(0);
        for (const path of evidence.tests) expect(path).toMatch(TEST_PATH);
        for (const path of evidence.code) expect(path).not.toMatch(TEST_PATH);
      });

      test("names only plain repository paths that exist", () => {
        for (const path of [...evidence.code, ...evidence.tests]) expect(path).toMatch(SAFE_PATH);
        expect(missing(evidence)).toEqual([]);
      });
    });
  }

  test("a path that does not exist is reported", () => {
    expect(
      missing({ code: ["apps/web/lib/stellar/verify.ts"], tests: ["apps/web/nope.test.ts"] })
    ).toEqual(["apps/web/nope.test.ts"]);
  });

  test("each link opens the file on main in the repository", () => {
    expect(repoFileUrl("apps/web/proxy.ts")).toBe(`${REPO_URL}/blob/main/apps/web/proxy.ts`);
  });
});
