import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LabRefusal } from "./home";
import type { UpstreamKind } from "./span-label.ts";
import { parseSpans, type Span } from "./spans";

/** The public providers the local API reads unless the lab config names others. */
export const PUBLIC_PROVIDERS: Record<string, string> = {
  STELLAR_RPC_TESTNET:
    "https://soroban-rpc.testnet.stellar.gateway.fm,https://soroban-testnet.stellar.org",
  STELLAR_RPC_MAINNET: "https://mainnet.sorobanrpc.com",
  PATH_ROUTING_API_TESTNET: "https://horizon-testnet.stellar.org",
  PATH_ROUTING_API_MAINNET: "https://horizon.stellar.org",
};

const OVERRIDABLE = new Set([
  ...Object.keys(PUBLIC_PROVIDERS),
  "OCTOPOS_API_URL_MAINNET",
  "OCTOPOS_API_KEY",
  "SOROSWAP_API_KEY",
]);
const HEADER_VAR = /^(STELLAR_RPC|PATH_ROUTING_API)_HEADER_(NAME|VALUE)_(MAINNET|TESTNET)(_[23])?$/;

const KIND_OF: Record<string, UpstreamKind> = {
  STELLAR_RPC_TESTNET: "rpc",
  STELLAR_RPC_MAINNET: "rpc",
  PATH_ROUTING_API_TESTNET: "horizon",
  PATH_ROUTING_API_MAINNET: "horizon",
  OCTOPOS_API_URL_MAINNET: "defi",
};

/** The span recorder is TypeScript loaded with `--import`, which needs Node's built-in type
 *  stripping: on by default from 22.18 and 23.6. */
export function assertNodeStripsTypes(version: string): void {
  const m = /^v(\d+)\.(\d+)\./.exec(version);
  const [major, minor] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
  const ok = major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
  if (!ok) {
    throw new LabRefusal(
      `the local target needs Node 22.18 or later (it loads a TypeScript preload); found ${version || "none"}`
    );
  }
}

/** A fresh key per run: it exists only in this process and the child's environment. */
export function throwawayApiKey(): string {
  return `lab_${randomBytes(24).toString("base64url")}`;
}

export function upstreamMap(env: Record<string, string>): Record<string, UpstreamKind> {
  const map: Record<string, UpstreamKind> = {};
  for (const [name, kind] of Object.entries(KIND_OF)) {
    for (const url of (env[name] ?? "").split(",").map((u) => u.trim())) {
      if (url) map[url] = kind;
    }
  }
  return map;
}

/**
 * The whole environment of the local API process. Nothing is inherited from the shell, and the
 * process runs in an empty folder, so no `.env.local` or other env file in the checkout is read.
 */
export function childEnv(opts: {
  port: number;
  apiKey: string;
  spansFile: string;
  overrides?: Record<string, string>;
}): Record<string, string> {
  const overrides = opts.overrides ?? {};
  for (const name of Object.keys(overrides)) {
    if (!OVERRIDABLE.has(name) && !HEADER_VAR.test(name)) {
      throw new LabRefusal(`local.env may not set ${name}: only provider endpoints and their keys`);
    }
  }
  const providers = { ...PUBLIC_PROVIDERS, ...overrides };
  return {
    NODE_ENV: "production",
    PORT: String(opts.port),
    API_KEYS: `lab=${opts.apiKey}`,
    ...providers,
    LUMENWIPE_LAB_SPANS: opts.spansFile,
    LUMENWIPE_LAB_UPSTREAMS: JSON.stringify(upstreamMap(providers)),
  };
}

export interface LocalApi {
  baseUrl: string;
  bootMs: number;
  spans(): Span[];
  stop(): Promise<void>;
}

export interface SpawnLike {
  (
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string> }
  ): ChildProcess;
}

export async function startLocalApi(opts: {
  node: string;
  mainJs: string;
  recorder: string;
  /** The child's environment, given the file its upstream calls are recorded to. */
  envFor: (spansFile: string) => Record<string, string>;
  spawnProcess?: SpawnLike;
  fetchImpl?: typeof fetch;
  bootTimeoutMs?: number;
}): Promise<LocalApi> {
  const spawnProcess: SpawnLike =
    opts.spawnProcess ?? ((c, a, o) => spawn(c, a, { ...o, stdio: ["ignore", "ignore", "pipe"] }));
  const doFetch = opts.fetchImpl ?? fetch;
  const cwd = mkdtempSync(join(tmpdir(), "lumenwipe-lab-api-"));
  const spansFile = join(cwd, "spans.jsonl");
  const env = opts.envFor(spansFile);
  const startedAt = performance.now();
  const child = spawnProcess(opts.node, ["--import", opts.recorder, opts.mainJs], { cwd, env });
  let spawnError: Error | undefined;
  child.once("error", (error: Error) => {
    spawnError = error;
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });
  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((r) => child.once("exit", r));
      child.kill("SIGTERM");
      await Promise.race([exited, Bun.sleep(5000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    rmSync(cwd, { recursive: true, force: true });
  };
  const baseUrl = `http://127.0.0.1:${env.PORT}`;
  const spans = (): Span[] =>
    existsSync(spansFile) ? parseSpans(readFileSync(spansFile, "utf8")) : [];
  const deadline = startedAt + (opts.bootTimeoutMs ?? 60_000);
  while (performance.now() < deadline) {
    if (child.exitCode !== null || spawnError) break;
    try {
      const res = await doFetch(`${baseUrl}/health`);
      if (res.ok) return { baseUrl, bootMs: performance.now() - startedAt, spans, stop };
    } catch {
      // not listening yet
    }
    await Bun.sleep(200);
  }
  await stop();
  throw new Error(
    `the local API did not become healthy: ${spawnError?.message ?? stderr.trim().split("\n").pop() ?? ""}`
  );
}
