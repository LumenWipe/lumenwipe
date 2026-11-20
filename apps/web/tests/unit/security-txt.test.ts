import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CANONICAL_ORIGIN } from "@/config/apex-redirect.mjs";
import { SECURITY_EMAIL, SECURITY_POLICY_URL, SECURITY_TXT_PATH } from "@/lib/site/trust";

const WEB = join(import.meta.dir, "..", "..");
const ROOT = join(WEB, "..", "..");
const FILE = readFileSync(join(WEB, "public", SECURITY_TXT_PATH), "utf8");
const POLICY = readFileSync(join(ROOT, "SECURITY.md"), "utf8");
const DAY_MS = 24 * 60 * 60 * 1000;

/** Each field's values, in file order, comments and blank lines left out (RFC 9116, Section 2.4). */
function fields(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) {
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Za-z-]+): (.+)$/.exec(line);
    if (!match) throw new Error(`not a field line: ${line}`);
    const name = match[1]!.toLowerCase();
    out.set(name, [...(out.get(name) ?? []), match[2]!]);
  }
  return out;
}

const FIELDS = fields(FILE);
const one = (name: string) => {
  const values = FIELDS.get(name) ?? [];
  expect(values).toHaveLength(1);
  return values[0]!;
};

/** Whether `expires` is valid on `now`: more than 30 days ahead, so a lapse fails CI a month
 *  early, and at most 366 days ahead, as RFC 9116 asks. */
function expiryWithinWindow(expires: string, now: Date): boolean {
  const ahead = new Date(expires).getTime() - now.getTime();
  return ahead > 30 * DAY_MS && ahead <= 366 * DAY_MS;
}

describe("/.well-known/security.txt", () => {
  test("names only the fields RFC 9116 defines, and each once except Contact", () => {
    const known = ["contact", "expires", "preferred-languages", "policy", "canonical"];
    expect([...FIELDS.keys()].sort()).toEqual(known.sort());
    for (const name of known.filter((n) => n !== "contact")) one(name);
  });

  test("its contact is the address SECURITY.md gives", () => {
    expect(FIELDS.get("contact")).toEqual([`mailto:${SECURITY_EMAIL}`]);
    expect(POLICY).toContain(`**${SECURITY_EMAIL}**`);
  });

  test("its policy is SECURITY.md, and SECURITY.md names the file and its languages", () => {
    expect(one("policy")).toBe(SECURITY_POLICY_URL);
    expect(POLICY).toContain(`${CANONICAL_ORIGIN}${SECURITY_TXT_PATH}`);
    expect(one("preferred-languages")).toBe("en, es");
    expect(POLICY).toContain("Reports are welcome in English or Spanish.");
  });

  test("its canonical URL is where the site serves it", () => {
    expect(one("canonical")).toBe(`${CANONICAL_ORIGIN}${SECURITY_TXT_PATH}`);
  });

  test("expires is an ISO 8601 UTC timestamp more than 30 and at most 366 days ahead", () => {
    const expires = one("expires");
    expect(expires).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
    expect(Number.isNaN(new Date(expires).getTime())).toBe(false);
    expect(expiryWithinWindow(expires, new Date())).toBe(true);
  });

  test("the expiry window fails a date inside its last 30 days or more than 366 days out", () => {
    const now = new Date("2027-01-01T00:00:00.000Z");
    expect(expiryWithinWindow("2027-01-31T00:00:00.000Z", now)).toBe(false);
    expect(expiryWithinWindow("2027-01-31T00:00:01.000Z", now)).toBe(true);
    expect(expiryWithinWindow("2028-01-02T00:00:00.000Z", now)).toBe(true);
    expect(expiryWithinWindow("2028-01-02T00:00:00.001Z", now)).toBe(false);
    expect(expiryWithinWindow("2026-12-31T00:00:00.000Z", now)).toBe(false);
  });
});
