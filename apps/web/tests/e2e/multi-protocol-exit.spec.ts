import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "@playwright/test";
import { Asset, Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  AQUARIUS_POOL,
  AQUARIUS_ROUTER,
  AQUA,
  AQUA_SAC,
  BLEND_POOL,
  SOROSWAP_FACTORY,
  SOROSWAP_ROUTER,
  XLM_SAC,
  accountExists,
  blendPositionExists,
  fund,
  ingested,
  seedAquariusLiquidity,
  seedBlendSupply,
  seedSoroswapLiquidity,
  soroswapPairFor,
  tokenBalanceOf,
} from "./fixtures/defi-seeds";

// E2E for a close that has to leave every protocol the exit adapters support at once, against
// live TESTNET, API-only (plan -> transactions -> sign -> submit, repeated until done). One
// account holds a Blend supply, a Soroswap LP position in a brand-new pair, and an Aquarius LP
// position in an existing pool; the plan must lead with one exit step per protocol, every exit
// transaction must be a call on that protocol's own contract acting only for the account, and
// on-chain nothing may be left behind before the merge. Testnet only, never mainnet.

const registry = JSON.parse(
  readFileSync(resolve(__dirname, "../../../api/src/config/contract-registry.json"), "utf8")
) as { validUntil: string; entries: { address: string; verifiedLive: boolean }[] };
const registryExpired = new Date() > new Date(`${registry.validUntil}T23:59:59Z`);
const registered = (address: string) =>
  registry.entries.some((e) => e.address === address && e.verifiedLive);

// Every registered contract the seeds and the sweep depend on: the Blend pool, the Soroswap
// factory (pairs are enumerated from it) and router, and the Aquarius router (pools are enumerated
// from it; the pool this spec deposits into is one of them, not a registry entry of its own).
const DEPENDS_ON = [BLEND_POOL, SOROSWAP_FACTORY, SOROSWAP_ROUTER, AQUARIUS_ROUTER];

test.skip(
  registryExpired || !DEPENDS_ON.every(registered),
  registryExpired
    ? `contract registry expired on ${registry.validUntil}; re-verify it before running this spec`
    : "a protocol contract this spec seeds against is no longer a verifiedLive registry entry"
);

test("close API: Blend, Soroswap, and Aquarius positions on one account are all exited, then the account is merged", async ({
  request,
}) => {
  test.setTimeout(600_000);

  const issuer = Keypair.random();
  const source = Keypair.random();
  const destination = Keypair.random();
  await Promise.all([
    fund(issuer.publicKey()),
    fund(source.publicKey()),
    fund(destination.publicKey()),
  ]);
  await Promise.all([issuer, source].map((k) => ingested(k.publicKey())));
  const asset = new Asset("LWTEST", issuer.publicKey());

  // Seeds run one after another: every step spends the account's own sequence number.
  await seedBlendSupply(source, BigInt(100_000_000)); // 10 XLM supplied
  const assetSac = await seedSoroswapLiquidity(
    source,
    issuer,
    asset,
    BigInt(50_000_000), // 5 XLM
    BigInt(50_000_000) // 5 LWTEST
  );
  const pair = await soroswapPairFor(assetSac, source.publicKey());
  const shareToken = await seedAquariusLiquidity(source, BigInt(20_000_000), BigInt(10_000_000));

  expect(await blendPositionExists(source.publicKey())).toBe(true);
  expect(await tokenBalanceOf(pair, source.publicKey())).toBeGreaterThan(BigInt(0));
  expect(await tokenBalanceOf(shareToken, source.publicKey())).toBeGreaterThan(BigInt(0));

  const body = {
    source: source.publicKey(),
    destination: destination.publicKey(),
    decisions: [
      { id: `destination:${destination.publicKey()}`, choice: "i_control_this_address" },
      // Both withdrawals pay classic assets back into their trustlines; they go to their issuers.
      { id: `asset:LWTEST-${issuer.publicKey()}`, choice: "return_to_issuer" },
      { id: `asset:AQUA-${AQUA.getIssuer()}`, choice: "return_to_issuer" },
    ],
  };

  // 1. Plan: the sweep finds all three positions and the plan leads with one exit per protocol.
  await expect
    .poll(
      async () => {
        const res = await request.post("/api/v1/testnet/close/plan", { data: body });
        if (!res.ok()) return `http ${res.status()}`;
        const plan = await res.json();
        const steps = Array.isArray(plan.steps)
          ? (plan.steps as Array<{ type: string; title: string }>)
          : [];
        const exits = steps.filter((s) => s.type === "EXIT_POSITIONS");
        return `${plan.status}:${exits.length}:${exits
          .map((s) => s.title)
          .sort()
          .join("|")}`;
      },
      { timeout: 120_000, intervals: [5_000] }
    )
    .toMatch(/^ready:3:Exit Aquarius [^|]+\|Exit Blend [^|]+\|Exit Soroswap /);

  // 2. Rounds: every exit transaction calls its own protocol's contract - the Blend pool, the
  //    Soroswap router, the Aquarius pool - acting only for the account being closed and naming
  //    only that protocol's contracts and the tokens involved; the classic close follows.
  const allowedContracts: Record<string, string[]> = {
    [BLEND_POOL]: [BLEND_POOL, XLM_SAC],
    [SOROSWAP_ROUTER]: [SOROSWAP_ROUTER, pair, XLM_SAC, assetSac],
    [AQUARIUS_POOL]: [AQUARIUS_POOL, shareToken, XLM_SAC, AQUA_SAC],
  };
  const exitContracts: string[] = [];
  const covered: string[][] = [];
  let finished = false;
  for (let round = 0; round < 12 && !finished; round++) {
    const txRes = await request.post("/api/v1/testnet/close/transactions", { data: body });
    expect(txRes.ok(), await txRes.text()).toBeTruthy();
    const { transactions, remaining } = await txRes.json();
    expect(transactions.length).toBeGreaterThan(0);

    for (const closeTx of transactions) {
      covered.push(closeTx.covers);
      if (closeTx.covers.includes("EXIT_POSITIONS")) {
        expect(closeTx.intent.operations).toHaveLength(1);
        const op = closeTx.intent.operations[0];
        expect(op).toMatchObject({
          type: "invoke_host_function",
          accountsReferenced: [source.publicKey()],
          unsupportedAddressCount: 0,
          authorizesBeyondSelf: false,
        });
        const allowed = allowedContracts[op.contract as string];
        expect(allowed, `exit against an unexpected contract ${op.contract}`).toBeDefined();
        // The tree always names at least the contract being called; an empty list is a bug.
        expect(op.contractsReferenced).toContain(op.contract);
        for (const contract of op.contractsReferenced as string[])
          expect(allowed).toContain(contract);
        exitContracts.push(op.contract);
      }
      const tx = TransactionBuilder.fromXDR(
        closeTx.xdr,
        closeTx.networkPassphrase ?? Networks.TESTNET
      );
      tx.sign(source);
      const submitRes = await request.post("/api/v1/testnet/submit", {
        data: { signedXdr: tx.toEnvelope().toXDR("base64") },
      });
      const label = `${closeTx.covers.join("+")} · ${closeTx.intent.summary} · source ${source.publicKey()} · xdr ${closeTx.xdr}`;
      expect(submitRes.ok(), `${label}\n${await submitRes.text()}`).toBeTruthy();
      expect((await submitRes.json()).status).toBe("success");
    }
    finished = !remaining.requiresAnotherCall;
  }
  expect(finished, "the close did not finish within 12 rounds").toBe(true);

  // Blend and Soroswap were each left in exactly one transaction; Aquarius in one, or two when a
  // reward claim preceded the withdrawal. Every exit came before the first classic step.
  const count = (contract: string) => exitContracts.filter((c) => c === contract).length;
  expect(count(BLEND_POOL)).toBe(1);
  expect(count(SOROSWAP_ROUTER)).toBe(1);
  expect([1, 2]).toContain(count(AQUARIUS_POOL));
  expect(exitContracts).toHaveLength(
    count(BLEND_POOL) + count(SOROSWAP_ROUTER) + count(AQUARIUS_POOL)
  );
  const firstClassic = covered.findIndex((c) => !c.includes("EXIT_POSITIONS"));
  const lastExit = covered.map((c) => c.includes("EXIT_POSITIONS")).lastIndexOf(true);
  expect(lastExit).toBeGreaterThanOrEqual(0);
  expect(firstClassic).toBeGreaterThan(lastExit);
  expect(covered.flat()).toContain("MERGE");

  // 3. On-chain: nothing left in any protocol, and the account is gone. Reads may lag the last
  //    ledger by a moment, so each is polled rather than read once.
  const settled = { timeout: 30_000, intervals: [2_000] };
  await expect.poll(() => blendPositionExists(source.publicKey()), settled).toBe(false);
  await expect.poll(() => tokenBalanceOf(pair, source.publicKey()), settled).toBe(BigInt(0));
  await expect.poll(() => tokenBalanceOf(shareToken, source.publicKey()), settled).toBe(BigInt(0));
  await expect.poll(() => accountExists(source.publicKey()), settled).toBe(false);
});
