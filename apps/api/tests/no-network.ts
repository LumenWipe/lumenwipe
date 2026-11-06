import { afterAll, afterEach } from "bun:test";
import { ClientRequest } from "node:http";

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

// @stellar/stellar-sdk reaches the network through fetch under Bun; this covers axios and any
// other node:http(s) client, whose requests all go out through ClientRequest.prototype.end.
type Sender = (this: ClientRequest, ...args: unknown[]) => ClientRequest;
const proto = ClientRequest.prototype as unknown as Record<string, Sender>;
for (const method of ["write", "end", "flushHeaders"]) {
  const send = proto[method];
  if (!send) continue;
  proto[method] = function (this: ClientRequest, ...args: unknown[]): ClientRequest {
    if (this.destroyed) return this;
    if (!isLoopback(this.host)) {
      const target = `${this.method} ${this.protocol}//${this.host}${this.path}`;
      this.destroy(refuse(`node:http ${target}`));
      return this;
    }
    return send.apply(this, args);
  };
}

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
