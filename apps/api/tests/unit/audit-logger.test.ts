import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Logger } from "@nestjs/common";
import { AuditLogger, keyIdOf } from "@/common/audit-logger";
import { JsonLogger } from "@/common/json-logger";
import { hashApiKey } from "@/auth/api-key-store";

const lines: Record<string, unknown>[] = [];

beforeEach(() => {
  lines.length = 0;
  Logger.overrideLogger(new JsonLogger((line) => lines.push(JSON.parse(line))));
});

afterEach(() => {
  Logger.overrideLogger(["log", "warn", "error"]);
});

describe("keyIdOf", () => {
  test("cuts a real key hash to its first 8 hex characters", () => {
    const hash = hashApiKey("lw_synthetic-key-material");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(keyIdOf(hash)).toBe(hash.slice(0, 8));
    expect(keyIdOf(hash)).toHaveLength(8);
  });

  test("returns null for anything that is not a full lowercase hex hash", () => {
    const hash = hashApiKey("lw_synthetic-key-material");
    for (const value of [
      null,
      undefined,
      "",
      "hash-0",
      hash.slice(1),
      `${hash}0`,
      hash.toUpperCase(),
      `${hash.slice(0, 8)} injected`,
    ]) {
      expect(keyIdOf(value)).toBeNull();
    }
  });
});

describe("AuditLogger.track", () => {
  const audit = new AuditLogger();
  const hash = hashApiKey("lw_synthetic-key-material");
  const newHash = hashApiKey("lw_other-synthetic-key-material");

  test("writes one success line with the lifecycle fields", async () => {
    const result = await audit.track("api_key.rotate", "admin", async (scope) => {
      scope.owner = "acme";
      scope.keyHash = hash;
      scope.newKeyHash = newHash;
      return "done";
    });

    expect(result).toBe("done");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      severity: "INFO",
      context: "audit",
      event: "api_key.rotate",
      actor: "admin",
      keyId: hash.slice(0, 8),
      newKeyId: newHash.slice(0, 8),
      owner: "acme",
      result: "success",
    });
    expect(JSON.stringify(lines)).not.toContain(hash);
    expect(JSON.stringify(lines)).not.toContain(newHash);
  });

  test("writes one failure line and rethrows the same exception", async () => {
    const failure = new Error(`store down ${hash}`);

    const thrown = await audit
      .track("api_key.revoke", "admin", async (scope) => {
        scope.keyHash = hash;
        throw failure;
      })
      .catch((e: unknown) => e);

    expect(thrown).toBe(failure);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      severity: "WARNING",
      event: "api_key.revoke",
      keyId: hash.slice(0, 8),
      owner: null,
      result: "failure",
    });
    expect(lines[0]).not.toHaveProperty("newKeyId");
    expect(JSON.stringify(lines)).not.toContain("store down");
    expect(JSON.stringify(lines)).not.toContain(hash);
  });

  test("a full wallet address leaves only in the cut form", async () => {
    const address = `G${"A".repeat(55)}`;
    await audit.track("api_key.create", address, async (scope) => {
      scope.owner = address;
    });

    expect(JSON.stringify(lines)).not.toContain(address);
    expect(lines[0]!.actor).toMatch(/^GAAA\.\.\.AAAA~[0-9a-f]{8}$/);
    expect(lines[0]!.owner).toBe(lines[0]!.actor);
  });
});
