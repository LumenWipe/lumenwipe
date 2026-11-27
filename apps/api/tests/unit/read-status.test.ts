import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpstreamError } from "@/lib/stellar/upstream-client";
import { ReadStatusRecorder } from "../support/read-status";

const dir = mkdtempSync(join(tmpdir(), "read-status-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the monitor read status", () => {
  test("no failure is no status, and nothing is written", () => {
    const recorder = new ReadStatusRecorder();
    const path = join(dir, "clean");
    recorder.write(path);
    expect(recorder.status()).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  test.each(["rate_limited", "timeout", "unavailable", "bad_response"] as const)(
    "a %s read is incomplete, not a finding",
    (kind) => {
      const recorder = new ReadStatusRecorder();
      recorder.record(new UpstreamError(kind, "rpc"));
      expect(recorder.status()).toBe("incomplete");
    }
  );

  test("a request that never got a response is incomplete", () => {
    const recorder = new ReadStatusRecorder();
    recorder.record(Object.assign(new Error("ECONNREFUSED"), { isAxiosError: true }));
    expect(recorder.status()).toBe("incomplete");
  });

  test("an HTTP error the client did not type as an outage is a finding", () => {
    const recorder = new ReadStatusRecorder();
    recorder.record(
      Object.assign(new Error("Request failed with status code 400"), {
        isAxiosError: true,
        response: { status: 400 },
      })
    );
    expect(recorder.status()).toBe("finding");
  });

  test.each([new Error("the contract instance entry is malformed"), "a string", null])(
    "any other failure is a finding: %p",
    (error) => {
      const recorder = new ReadStatusRecorder();
      recorder.record(error);
      expect(recorder.status()).toBe("finding");
    }
  );

  test("a finding wins over reads that failed, in either order", () => {
    const first = new ReadStatusRecorder();
    first.finding();
    first.record(new UpstreamError("rate_limited", "rpc"));
    const second = new ReadStatusRecorder();
    second.record(new UpstreamError("rate_limited", "rpc"));
    second.finding();
    expect([first.status(), second.status()]).toEqual(["finding", "finding"]);
  });

  test("a watched body that fails on a read is incomplete and still fails", async () => {
    const recorder = new ReadStatusRecorder();
    const error = new UpstreamError("timeout", "rpc");
    const body = recorder.watch(() => Promise.reject(error));
    expect(body()).rejects.toBe(error);
    await body().catch(() => undefined);
    expect(recorder.status()).toBe("incomplete");
  });

  test("a watched body that fails an assertion is a finding", async () => {
    const recorder = new ReadStatusRecorder();
    const body = recorder.watch(async () => {
      expect(["hash"]).toEqual([]);
    });
    await body().catch(() => undefined);
    expect(recorder.status()).toBe("finding");
  });

  test("a watched body that passes records nothing", async () => {
    const recorder = new ReadStatusRecorder();
    await recorder.watch(async () => undefined)();
    expect(recorder.status()).toBeNull();
  });

  test("the status is written to the given file, and nowhere without one", () => {
    const recorder = new ReadStatusRecorder();
    recorder.record(new UpstreamError("unavailable", "rpc"));
    const path = join(dir, "status");
    recorder.write(undefined);
    recorder.write(path);
    expect(readFileSync(path, "utf8")).toBe("incomplete");
  });
});
