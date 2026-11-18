import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Keypair } from "@stellar/stellar-sdk";
import { relayKey } from "@/lib/stellar/mediator-server";

// #1039: sign, /mediator/check and the close plan's blocker all decide whether the relay can
// co-sign through relayKey, so a key that does not match MEDIATOR_PUBLIC_<NETWORK> is reported
// unavailable before the user signs instead of being refused by /mediator/sign afterwards.

describe("relayKey", () => {
  const relay = Keypair.random();

  test("a key that matches its configured public key is usable, with that key", () => {
    const result = relayKey(
      { keypair: () => relay, configuredPublicKey: () => relay.publicKey() },
      "testnet"
    );
    expect(result).toEqual({ state: "usable", keypair: relay });
  });

  test("a key that does not match its configured public key is a mismatch", () => {
    const result = relayKey(
      { keypair: () => relay, configuredPublicKey: () => Keypair.random().publicKey() },
      "testnet"
    );
    expect(result).toEqual({ state: "mismatch" });
  });

  test("an unset public key with a loaded key is not configured", () => {
    const result = relayKey({ keypair: () => relay, configuredPublicKey: () => "" }, "testnet");
    expect(result).toEqual({ state: "not_configured" });
  });

  test("no key with a public key set is not configured", () => {
    const result = relayKey(
      { keypair: () => null, configuredPublicKey: () => relay.publicKey() },
      "testnet"
    );
    expect(result).toEqual({ state: "not_configured" });
  });

  test("each network is read on its own", () => {
    const asked: string[] = [];
    relayKey(
      {
        keypair: (n) => (asked.push(`keypair:${n}`), relay),
        configuredPublicKey: (n) => (asked.push(`public:${n}`), relay.publicKey()),
      },
      "mainnet"
    );
    expect(asked).toEqual(["keypair:mainnet", "public:mainnet"]);
  });
});

// config/networks.ts reads MEDIATOR_PUBLIC_<NETWORK> once at import, so the kill-switch reader is
// exercised in a child process per environment, as networks-env-rename.test.ts does.
const killSwitchesPath = join(import.meta.dir, "..", "..", "src", "config", "kill-switches.ts");
const apiDir = join(import.meta.dir, "..", "..");

async function mediatorConfigured(env: Record<string, string>): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), "relay-key-"));
  try {
    const harness = join(dir, "harness.ts");
    writeFileSync(
      harness,
      [
        `import { readKillSwitches } from "${killSwitchesPath}";`,
        `process.stdout.write(JSON.stringify(readKillSwitches("testnet", {}).mediatorConfigured));`,
        "",
      ].join("\n")
    );
    // Every mediator variable the parent has is dropped, so only what this call sets is read.
    const spawnEnv: Record<string, string | undefined> = { ...process.env };
    for (const key of Object.keys(spawnEnv)) {
      if (key.startsWith("MEDIATOR_") || key.startsWith("NEXT_PUBLIC_MEDIATOR_")) {
        delete spawnEnv[key];
      }
    }
    const proc = Bun.spawn(["bun", "run", harness], {
      cwd: apiDir,
      env: { ...spawnEnv, ...env, NODE_ENV: "test" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) throw new Error(`harness exited ${exitCode}: ${stderr}`);
    return JSON.parse(stdout) as boolean;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the close plan's relay reader", () => {
  test("a key that matches its public key is configured", async () => {
    const relay = Keypair.random();
    expect(
      await mediatorConfigured({
        MEDIATOR_SECRET_TESTNET: relay.secret(),
        MEDIATOR_PUBLIC_TESTNET: relay.publicKey(),
      })
    ).toBe(true);
  });

  test("a key that does not match its public key is not configured", async () => {
    expect(
      await mediatorConfigured({
        MEDIATOR_SECRET_TESTNET: Keypair.random().secret(),
        MEDIATOR_PUBLIC_TESTNET: Keypair.random().publicKey(),
      })
    ).toBe(false);
  });

  test("an unset public key is not configured", async () => {
    expect(await mediatorConfigured({ MEDIATOR_SECRET_TESTNET: Keypair.random().secret() })).toBe(
      false
    );
  });
});
