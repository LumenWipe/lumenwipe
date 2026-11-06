import { afterEach, expect, test } from "bun:test";
import { get } from "node:https";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { rpc } from "@stellar/stellar-sdk";
import { isLoopback, takeBlockedRequests } from "../no-network";

afterEach(() => {
  takeBlockedRequests();
});

function failure(start: (fail: (e: Error) => void) => void): Promise<Error> {
  return new Promise((resolve) => start(resolve));
}

test("fetch to a real host is refused at once, naming the url", async () => {
  const error = await fetch("https://horizon.example/accounts/x").catch((e: Error) => e);

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("https://horizon.example/accounts/x");
  expect(takeBlockedRequests()).toEqual([
    expect.stringMatching(
      /^fetch https:\/\/horizon\.example\/accounts\/x \(from tests\/unit\/no-network-guard\.test\.ts:\d+\)$/
    ),
  ]);
});

test("the stellar sdk's rpc client is refused, naming its endpoint", async () => {
  const error = await new rpc.Server("https://rpc.example")
    .getLatestLedger()
    .catch((e: Error) => e);

  expect(String(error)).toContain("https://rpc.example/");
  expect(takeBlockedRequests()).toEqual([expect.stringContaining("fetch https://rpc.example/")]);
});

test("a refusal the code swallows is still recorded against the test", async () => {
  const degraded = await fetch("https://rpc.example/swallowed").then(
    () => "read",
    () => "fell back"
  );

  expect(degraded).toBe("fell back");
  expect(takeBlockedRequests()).toEqual([
    expect.stringContaining("fetch https://rpc.example/swallowed (from tests/unit/"),
  ]);
});

test("node:http(s) to a real host is refused, naming the url", async () => {
  const viaHttps = await failure((fail) => {
    get("https://horizon.example/ledgers").on("error", fail);
  });
  const viaHttp = await failure((fail) => {
    request("http://horizon.example/offers", { method: "POST" }).on("error", fail).end();
  });

  expect(viaHttps.message).toContain("GET https://horizon.example/ledgers");
  expect(viaHttp.message).toContain("POST http://horizon.example/offers");
  expect(takeBlockedRequests()).toHaveLength(2);
});

test("loopback is never refused, through fetch or node:http", async () => {
  const server = createServer((_, res) => res.end("ok")).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    // Bun's fetch honours HTTP(S)_PROXY even for loopback, so only the guard's verdict is asserted.
    await fetch(`http://127.0.0.1:${port}/`).catch(() => undefined);
    expect(takeBlockedRequests()).toEqual([]);
    const body = await new Promise<string>((resolve, reject) => {
      request(`http://localhost:${port}/`, (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => (text += chunk.toString()));
        res.on("end", () => resolve(text));
      })
        .on("error", reject)
        .end();
    });
    expect(body).toBe("ok");
  } finally {
    server.close();
  }
  expect(takeBlockedRequests()).toEqual([]);
});

test("loopback is only localhost and 127.0.0.0/8 and ::1", () => {
  expect(["localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]"].every(isLoopback)).toBe(true);
  expect(["soroban-testnet.stellar.org", "10.0.0.1", "127.example"].some(isLoopback)).toBe(false);
});
