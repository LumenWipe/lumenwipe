import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Keypair, Networks, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { LumenWipeClient } from "@lumenwipe/sdk";
import { loadConfig, type LabConfig } from "./config";
import { runE2e } from "./e2e";
import { requireNetwork, resolveBalanceCap, type LedgerAccount } from "./guards";
import {
  LabRefusal,
  checkoutRoot,
  labHome,
  productionApiKey,
  readPrivateFile,
  withoutLabEnv,
} from "./home";
import { assertNodeStripsTypes, childEnv, startLocalApi, throwawayApiKey } from "./local-api";
import {
  measure,
  MIN_RUNS,
  type ScenarioResult,
  type TargetKind,
  type TargetSession,
} from "./measure";
import { renderReport, writeResults } from "./report";
import { NETWORKS, allScenarios, type Network } from "./scenarios";
import { verifyLabClose } from "./verify-close";

const USAGE = `Usage:
  bun run lab measure [--target local|production|both] [--network testnet|mainnet|both]
                      [--runs 5-11] [--rounds N] [--pause-ms N] [--scenario id,id] [--no-build]
  bun run lab e2e --target local|production --network testnet|mainnet --destination G...
                  [--submit]`;

const PASSPHRASES: Record<Network, string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
};

function pick<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  flag: string
): T[] {
  if (value === undefined || value === "both") return [...allowed];
  if (!(allowed as readonly string[]).includes(value)) {
    throw new LabRefusal(`--${flag} must be one of ${allowed.join(", ")} or both`);
  }
  return [value as T];
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject()
      );
    });
  });
}

function gitCommit(root: string): string {
  const out = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    env: withoutLabEnv(process.env),
  });
  return out.status === 0 ? out.stdout.trim() : "unknown";
}

function nodeBinary(): { path: string; version: string } {
  const path = Bun.which("node");
  if (!path) {
    throw new LabRefusal("the local target runs the API under Node, and node is not on PATH");
  }
  const out = spawnSync(path, ["--version"], { encoding: "utf8", env: withoutLabEnv(process.env) });
  const version = out.stdout.trim();
  assertNodeStripsTypes(version);
  return { path, version };
}

function buildApi(root: string): void {
  const out = spawnSync(process.execPath, ["run", "--filter", "@lumenwipe/api", "build"], {
    cwd: root,
    stdio: "inherit",
    env: withoutLabEnv(process.env),
  });
  if (out.status !== 0) throw new Error("building the API failed");
}

function localOpener(
  root: string,
  config: LabConfig,
  apiKey: string
): () => Promise<TargetSession> {
  const node = nodeBinary().path;
  return async () => {
    const port = await freePort();
    const api = await startLocalApi({
      node,
      mainJs: join(root, "apps", "api", "dist", "main.js"),
      recorder: join(import.meta.dir, "span-recorder.ts"),
      envFor: (spansFile) => childEnv({ port, apiKey, spansFile, overrides: config.localEnv }),
    });
    return { baseUrl: api.baseUrl, apiKey, bootMs: api.bootMs, spans: api.spans, stop: api.stop };
  };
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function runMeasure(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      target: { type: "string" },
      network: { type: "string" },
      runs: { type: "string", default: String(MIN_RUNS) },
      rounds: { type: "string", default: "1" },
      "pause-ms": { type: "string", default: "300" },
      scenario: { type: "string" },
      "no-build": { type: "boolean", default: false },
    },
  });
  const targets = pick<TargetKind>(values.target, ["local", "production"], "target");
  const pauseMs = Number(values["pause-ms"]);
  if (!Number.isInteger(pauseMs) || pauseMs < 0)
    throw new LabRefusal("--pause-ms must be a whole number");
  const networks = pick<Network>(values.network, NETWORKS, "network");
  const root = checkoutRoot();
  const home = labHome();
  const config = loadConfig(home, root);
  const productionKey = targets.includes("production")
    ? productionApiKey(process.env, home, root)
    : "";
  const localKey = throwawayApiKey();
  const wanted = values.scenario?.split(",").map((s) => s.trim());
  const scenarios = allScenarios(networks).filter((s) => !wanted || wanted.includes(s.id));
  if (scenarios.length === 0) throw new LabRefusal("no scenario matches --scenario");

  const results: ScenarioResult[] = [];
  for (const target of targets) {
    if (target === "local" && !values["no-build"]) buildApi(root);
    const open =
      target === "local"
        ? localOpener(root, config, localKey)
        : async (): Promise<TargetSession> => ({
            baseUrl: config.productionUrl,
            apiKey: productionKey,
            stop: async () => {},
          });
    results.push(
      ...(await measure({
        target,
        scenarios,
        runs: Number(values.runs),
        rounds: Number(values.rounds),
        open,
        pause: () => Bun.sleep(pauseMs),
        log: (line) => console.error(line),
      }))
    );
  }

  const meta = {
    date: new Date().toISOString(),
    commit: gitCommit(root),
    targets: targets.join(", "),
    networks: networks.join(", "),
    "pause between requests": `${pauseMs} ms`,
    "local providers":
      Object.keys(config.localEnv).length > 0 ? "from config.json" : "public defaults",
    ...(targets.includes("local") && {
      "local runtime": `node ${nodeBinary().version}`,
    }),
  };
  const report = renderReport(meta, results);
  const written = writeResults(
    join(home, "results", stamp()),
    { "table.md": report, "results.json": `${JSON.stringify({ meta, results }, null, 2)}\n` },
    [productionKey, localKey, ...Object.values(config.localEnv)],
    root
  );
  console.log(report);
  console.error(`written: ${written.join(", ")}`);
}

async function horizonAccount(horizon: string, address: string): Promise<LedgerAccount | null> {
  const res = await fetch(`${horizon}/accounts/${address}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Horizon answered ${res.status} for the source account`);
  const body = (await res.json()) as {
    balances?: { asset_type: string; balance: string }[];
    signers?: { key: string; type: string; weight: number }[];
    thresholds?: { low_threshold: number; med_threshold: number; high_threshold: number };
  };
  const native = body.balances?.find((b) => b.asset_type === "native")?.balance;
  if (native === undefined || !body.signers || !body.thresholds) {
    throw new LabRefusal("Horizon returned an incomplete account for the source");
  }
  return {
    nativeBalance: native,
    signers: body.signers,
    thresholds: {
      low: body.thresholds.low_threshold,
      med: body.thresholds.med_threshold,
      high: body.thresholds.high_threshold,
    },
  };
}

async function runE2eCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      target: { type: "string" },
      network: { type: "string" },
      destination: { type: "string" },
      submit: { type: "boolean", default: false },
    },
  });
  const network = requireNetwork(values.network);
  if (values.target !== "local" && values.target !== "production") {
    throw new LabRefusal("e2e needs --target local or --target production");
  }
  const root = checkoutRoot();
  const home = labHome();
  const config = loadConfig(home, root);
  if (!config.e2e) throw new LabRefusal("e2e needs an e2e section in config.json (see the README)");
  const e2e = config.e2e;
  const capXlm = resolveBalanceCap(e2e.balanceCapXlm);
  const secret = readPrivateFile(e2e.sourceSecretFile, "The source secret file", root);
  const keypair = Keypair.fromSecret(secret);
  const passphrase = PASSPHRASES[network];
  const parse = (xdr: string): Transaction => {
    const tx = TransactionBuilder.fromXdr(xdr, passphrase);
    if (!(tx instanceof Transaction)) throw new Error("the lab does not sign fee-bump envelopes");
    return tx;
  };

  let apiKey: string;
  let session: TargetSession;
  if (values.target === "production") {
    apiKey = productionApiKey(process.env, home, root);
    session = { baseUrl: config.productionUrl, apiKey, stop: async () => {} };
  } else {
    apiKey = throwawayApiKey();
    buildApi(root);
    session = await localOpener(root, config, apiKey)();
  }

  try {
    const report = await runE2e({
      network,
      submit: values.submit,
      destination: values.destination,
      allowlist: e2e.destinations,
      capXlm,
      signer: {
        publicKey: keypair.publicKey(),
        sign: (xdr) => {
          const tx = parse(xdr);
          tx.sign(keypair);
          return tx.toEnvelope().toXdr("base64");
        },
        hash: (xdr) => Buffer.from(parse(xdr).hash()).toString("hex"),
      },
      api: new LumenWipeClient({ baseUrl: session.baseUrl, apiKey, network }),
      horizonAccount: (address) => horizonAccount(e2e.horizon[network], address),
      verify: (tx, account, destination) => verifyLabClose(tx, account, destination, network),
      prompt: async (question) => prompt(question),
      isTTY: process.stdin.isTTY === true,
      log: (line) => console.error(line),
    });
    const text = `${JSON.stringify({ date: new Date().toISOString(), commit: gitCommit(root), target: values.target, ...report }, null, 2)}\n`;
    const written = writeResults(
      join(home, "results", `e2e-${stamp()}`),
      { "e2e.json": text },
      [secret, apiKey, ...Object.values(config.localEnv)],
      root
    );
    console.log(text);
    console.error(`written: ${written.join(", ")}`);
  } finally {
    await session.stop();
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "measure") return runMeasure(rest);
  if (command === "e2e") return runE2eCommand(rest);
  console.error(USAGE);
  process.exitCode = 2;
}

main(Bun.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof LabRefusal ? `refused: ${error.message}` : error);
  process.exitCode = 1;
});
