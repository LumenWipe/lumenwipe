import { expect, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import { JsonLogger } from "@/common/json-logger";
import { scrubLogLine } from "@/common/log-privacy";
import { servedRegistry } from "@/lib/exchange-registry";

const PLACEHOLDER_SECRET = `S${"A".repeat(55)}`;

function capture(): { logger: JsonLogger; lines: string[] } {
  const lines: string[] = [];
  return { logger: new JsonLogger((line) => lines.push(line)), lines };
}

test("every line is one JSON object with a Cloud Logging severity", () => {
  const { logger, lines } = capture();
  logger.log("started", "Boot");
  logger.warn("careful", "Boot");
  logger.error("failed", "Error: boom\n    at x (y.ts:1:1)", "Boot");
  logger.debug("detail");
  logger.fatal("dead");
  const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(parsed.map((p) => p.severity)).toEqual(["INFO", "WARNING", "ERROR", "DEBUG", "CRITICAL"]);
  expect(parsed[0]).toMatchObject({ message: "started", context: "Boot" });
  expect(parsed[2]).toMatchObject({ context: "Boot", stack: "Error: boom\n    at x (y.ts:1:1)" });
  expect(lines.every((l) => !l.includes("\n"))).toBe(true);
});

test("structured fields are merged and cannot override the severity", () => {
  const { logger, lines } = capture();
  logger.log({ message: "request", status: 200, severity: "ERROR" });
  expect(JSON.parse(lines[0]!)).toMatchObject({
    message: "request",
    status: 200,
    severity: "INFO",
  });
});

test("an address is cut to four and four characters plus a stable keyed hash", () => {
  const address = Keypair.random().publicKey();
  const other = Keypair.random().publicKey();
  const out = scrubLogLine(`read ${address} then ${address} and ${other}`);
  expect(out).not.toContain(address);
  const shown = out.match(/G[A-Z2-7]{3}\.\.\.[A-Z2-7]{4}~[0-9a-f]{8}/g) ?? [];
  expect(shown).toHaveLength(3);
  expect(shown[0]!.startsWith(`${address.slice(0, 4)}...${address.slice(-4)}~`)).toBe(true);
  expect(shown[1]).toBe(shown[0]!);
  expect(shown[2]).not.toBe(shown[0]!);
});

test("an exchange deposit address becomes a fixed token with no prefix suffix or hash", () => {
  const exchange = servedRegistry().entries[0]!.address;
  const out = scrubLogLine(`destination ${exchange}`);
  expect(out).toBe("destination [exchange]");
});

test("secret-shaped strings, bearer tokens and XDR-sized blobs never survive", () => {
  const out = scrubLogLine(
    `key ${PLACEHOLDER_SECRET} Authorization: Bearer abc123 xdr ${"QUFB".repeat(60)}`
  );
  expect(out).not.toContain(PLACEHOLDER_SECRET);
  expect(out).not.toContain("abc123");
  expect(out).not.toContain("QUFB");
  expect(out).toContain("[redacted-secret]");
});

test("literals the request carried are removed, escaped or not", () => {
  expect(scrubLogLine('memo "a\\b" and a\\b', ["a\\b"])).toBe('memo "[memo]" and [memo]');
  expect(scrubLogLine("memo 12", ["12"])).toBe("memo 12");
});
