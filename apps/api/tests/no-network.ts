import { afterAll, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { Agent, type ClientRequest } from "node:http";
import { Socket } from "node:net";

// The node:http(s) refusal below relies on the Node http client that Bun 1.4 ships; older Bun
// sends those requests through a path no hook here sees, so the guard would prove nothing.
const { packageManager = "" } = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8")
) as { packageManager?: string };
const pinned = /^bun@(\d+\.\d+\.\d+)$/.exec(packageManager)?.[1];
if (!pinned) throw new Error(`the root package.json pins no Bun version: "${packageManager}"`);
if (Bun.semver.order(Bun.version, pinned) < 0) {
  throw new Error(
    `the unit suite needs Bun ${pinned} (packageManager in the root package.json), not ${Bun.version}: run it with \`bunx bun@${pinned} run test\` or upgrade Bun.`
  );
}

const LOOPBACK = new Set(["localhost", "::1", "[::1]"]);

const blocked: string[] = [];
const attempted: string[] = [];

export function isLoopback(hostname: string): boolean {
  return LOOPBACK.has(hostname.toLowerCase()) || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

export function takeBlockedRequests(): string[] {
  return blocked.splice(0);
}

function testFrame(): string {
  const frame = new Error().stack?.match(/(tests\/[^\s():]+\.test\.ts:\d+)/);
  return frame?.[1] ?? "test location not in the stack";
}

function refuse(target: string): Error {
  const attempt = `${target} (from ${testFrame()})`;
  blocked.push(attempt);
  return new Error(
    `real network request blocked in the unit suite: ${target}. Stub the call that makes it.`
  );
}

function fetchTarget(input: Parameters<typeof fetch>[0]): URL | null {
  const href = input instanceof Request ? input.url : String(input);
  return URL.canParse(href) ? new URL(href) : null;
}

const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = fetchTarget(input);
    if (
      url &&
      (url.protocol === "http:" || url.protocol === "https:") &&
      !isLoopback(url.hostname)
    ) {
      return Promise.reject(refuse(`fetch ${url.href}`));
    }
    return realFetch(input, init);
  },
  realFetch
);

// @stellar/stellar-sdk reaches the network through fetch under Bun. Every node:http(s) client (axios
// included) gets its socket from Agent.prototype.addRequest, which the ClientRequest constructor
// calls before any write or end and which starts the DNS lookup, TCP connect and TLS handshake at
// once. Refusing there means none of them happen. Handing the error to onSocket is how an agent
// reports a failed connection, so the request still emits error and close.
type AgentWithAddRequest = Agent & {
  addRequest(req: ClientRequest, options: unknown): void;
};
type RequestWithOnSocket = ClientRequest & { onSocket(socket: null, err: Error): void };
const agentProto = Agent.prototype as AgentWithAddRequest;
const addRequest = agentProto.addRequest;
agentProto.addRequest = function (this: AgentWithAddRequest, req, options) {
  if (isLoopback(req.host)) return addRequest.call(this, req, options);
  const target = `${req.method} ${req.protocol}//${req.host}${req.path}`;
  (req as RequestWithOnSocket).onSocket(null, refuse(`node:http ${target}`));
};

// The backstop for anything that opens a TCP socket without an agent: node:net, node:tls, or a
// request given its own createConnection.
interface ConnectTarget {
  host?: string;
  port?: unknown;
  // An IPC socket path; Node's own callers set it to null for TCP connections.
  path?: string | null;
}

function connectTarget(args: unknown[]): ConnectTarget {
  // Node's own callers pass the normalized arguments as an array in the first position.
  const first: unknown = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof first === "object" && first !== null) return first as ConnectTarget;
  if (typeof first === "number" || /^\d+$/.test(String(first))) {
    return { port: first, host: typeof args[1] === "string" ? args[1] : undefined };
  }
  return { path: String(first) };
}

const connect = Socket.prototype.connect as (this: Socket, ...args: unknown[]) => Socket;
Socket.prototype.connect = function (this: Socket, ...args: unknown[]): Socket {
  const { host = "localhost", port, path } = connectTarget(args);
  if (path || isLoopback(host)) return connect.apply(this, args);
  this.destroy(refuse(`node:net ${host}:${String(port)}`));
  return this;
} as typeof Socket.prototype.connect;

// Code under test often catches a failed read and degrades, so the refusal alone may not fail it.
afterEach(() => {
  const attempts = takeBlockedRequests();
  if (attempts.length > 0) {
    attempted.push(...attempts);
    throw new Error(
      `this test made a real network request, stub it:\n${attempts.map((a) => `  ${a}`).join("\n")}`
    );
  }
});

afterAll(() => {
  const outsideTests = takeBlockedRequests();
  attempted.push(...outsideTests);
  if (attempted.length === 0) return;
  const list = attempted.map((a) => `  ${a}`).join("\n");
  console.error(`\n${attempted.length} real network request(s) blocked in this run:\n${list}`);
  if (outsideTests.length > 0) throw new Error("a real network request was made outside a test");
});
