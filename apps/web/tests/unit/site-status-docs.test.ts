import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { feature, PROTOCOLS, type FeatureId } from "@/lib/site/status";

// The docs site cannot import the registry, so its generated tables are held to it here.

const DOCS = join(import.meta.dir, "..", "..", "..", "..", "docs");

function rows(text: string): string[][] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim())
    );
}

describe("docs agree with the status registry", () => {
  test("supported.mdx builds no mainnet exit for exactly the protocols not live", () => {
    const page = readFileSync(join(DOCS, "reference", "supported.mdx"), "utf8");
    const start = page.indexOf("generated:protocols:start");
    const block = page.slice(start, page.indexOf("generated:protocols:end"));
    const table = rows(block);
    for (const p of PROTOCOLS) {
      const mainnet = table.find((r) => r[0] === p.name && r[3] === "Mainnet");
      const blocked = mainnet === undefined || mainnet[4]!.includes("no exit is built");
      expect({ protocol: p.name, blocked }).toEqual({
        protocol: p.name,
        blocked: p.status !== "live",
      });
      const testnet = table.find((r) => r[0] === p.name && r[3] === "Testnet");
      expect({ protocol: p.name, testnet: testnet !== undefined }).toEqual({
        protocol: p.name,
        testnet: p.status !== "soon",
      });
    }
  });

  test("a feature run by an undeployed mainnet service account is testnet only", () => {
    const plan = readFileSync(join(DOCS, "monitoring-plan.md"), "utf8");
    const inventory = rows(plan);
    const accounts: Record<string, FeatureId> = {
      "Mediator account (mainnet)": "exchange-close",
      "Fee-bump sponsor (mainnet)": "sponsored-fees",
    };
    for (const [component, id] of Object.entries(accounts)) {
      const row = inventory.find((r) => r[0] === component);
      expect(row).toBeDefined();
      const deployed = row![1] !== "not yet deployed";
      expect({ id, status: feature(id).status }).toEqual({
        id,
        status: deployed ? "live" : "testnet-only",
      });
    }
  });
});
