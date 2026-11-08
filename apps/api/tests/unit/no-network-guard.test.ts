import { afterEach, expect, test } from "bun:test";
import { get } from "node:https";
import { type ClientRequest, createServer, request } from "node:http";
import {
  type AddressInfo,
  type NetConnectOpts,
  type Socket,
  connect,
  createServer as createNetServer,
} from "node:net";
import { rpc } from "@stellar/stellar-sdk";
import { isLoopback, takeBlockedRequests } from "../no-network";

afterEach(() => {
  takeBlockedRequests();
});

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

// These tests assert the refusal from the guard's record and from a listener that would see any
// connection, never by waiting for an error event: whether and when a refused request or socket
// emits one depends on the Bun release (1.3 emitted none for a request refused before it was sent),
// so each wait is bounded instead. Nothing here depends on state left by other test files, so the
// assertions hold whether this file runs alone or after the rest of the suite. 0.0.0.0 is not
// loopback to the guard but reaches this machine, so a request the guard let through shows up as a
// counted connection rather than as traffic to a real host.
async function listenOnThisMachine() {
  let connections = 0;
  const listener = createNetServer((socket) => {
    connections += 1;
    socket.destroy();
  }).listen(0, "0.0.0.0");
  await new Promise((resolve) => listener.once("listening", resolve));
  const { port } = listener.address() as AddressInfo;
  return {
    port,
    // A connection the guard let through is accepted after the client gives up; give it time to land.
    async connections(): Promise<number> {
      await new Promise((resolve) => setTimeout(resolve, 100));
      listener.close();
      return connections;
    },
  };
}

function settle(emitter: ClientRequest | Socket, errors: string[]): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 250);
    emitter.once("error", (e: Error) => errors.push(e.message));
    emitter.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

test("node:http(s) to a non-loopback host never connects, naming the url", async () => {
  const target = await listenOnThisMachine();
  const errors: string[] = [];

  await Promise.all([
    settle(get(`https://0.0.0.0:${target.port}/ledgers`), errors),
    settle(request(`http://0.0.0.0:${target.port}/offers`, { method: "POST" }).end(), errors),
  ]);

  expect(await target.connections()).toBe(0);
  expect(takeBlockedRequests()).toEqual([
    expect.stringMatching(/^node:http GET https:\/\/0\.0\.0\.0\/ledgers \(from tests\/unit\//),
    expect.stringMatching(/^node:http POST http:\/\/0\.0\.0\.0\/offers \(from tests\/unit\//),
  ]);
  expect(errors.every((m) => m.startsWith("real network request blocked"))).toBe(true);
});

test("a socket opened without an agent never connects to a non-loopback host", async () => {
  const target = await listenOnThisMachine();
  const errors: string[] = [];

  await Promise.all([
    settle(connect({ host: "0.0.0.0", port: target.port }), errors),
    settle(connect(target.port, "0.0.0.0"), errors),
    // Node's http agent passes path: null for a TCP socket; that is not an IPC path to let through.
    settle(connect({ host: "0.0.0.0", port: target.port, path: null } as NetConnectOpts), errors),
    // A request given its own createConnection skips the agent, so only the socket backstop sees it.
    settle(
      request(`http://0.0.0.0:${target.port}/trades`, {
        createConnection: () => connect({ host: "0.0.0.0", port: target.port }),
      }).end(),
      errors
    ),
  ]);

  expect(await target.connections()).toBe(0);
  expect(takeBlockedRequests()).toEqual(
    Array.from({ length: 4 }, () =>
      expect.stringContaining(`node:net 0.0.0.0:${target.port} (from tests/unit/`)
    )
  );
  expect(errors.every((m) => m.startsWith("real network request blocked"))).toBe(true);
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
