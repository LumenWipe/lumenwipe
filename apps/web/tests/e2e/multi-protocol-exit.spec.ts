import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "@playwright/test";
import { Asset, Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  AQUARIUS_POOL,
  AQUA,
  AQUA_SAC,
  BLEND_POOL,
  SOROSWAP_ROUTER,
  XLM_SAC,
  accountExists,
  blendPositionExists,
  fund,
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

test.skip(
  registryExpired || ![BLEND_POOL, SOROSWAP_ROUTER].every(registered),
  registryExpired
    ? `contract registry expired on ${registry.validUntil}; re-verify it before running this spec`
    : "a protocol contract this spec seeds against is no longer a verifiedLive registry entry"
);

test("close API: Blend, Soroswap, and Aquarius positions on one account are all exited, then the account is merged", async ({
  request,
}) => {
  test.setTimeout(900_000);

  const issuer = Keypair.random();
  const source = Keypair.random();
  const destination = Keypair.random();
  await Promise.all([
    fund(issuer.publicKey()),
    fund(source.publicKey()),
    fund(destination.publicKey()),
  ]);
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
        const exits = (plan.steps as Array<{ type: string; title: string }>).filter(
          (s) => s.type === "EXIT_POSITIONS"
        );
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
  for (let round = 0; round < 12; round++) {
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
    if (!remaining.requiresAnotherCall) break;
  }

  // Every protocol was left exactly once (Aquarius may add a reward claim), and the exits all
  // came before the classic steps.
  expect(new Set(exitContracts)).toEqual(new Set([BLEND_POOL, SOROSWAP_ROUTER, AQUARIUS_POOL]));
  const firstClassic = covered.findIndex((c) => !c.includes("EXIT_POSITIONS"));
  const lastExit = covered.map((c) => c.includes("EXIT_POSITIONS")).lastIndexOf(true);
  expect(lastExit).toBeLessThan(firstClassic);
  expect(covered.flat()).toContain("MERGE");

  // 3. On-chain: nothing left in any protocol, and the account is gone.
  expect(await blendPositionExists(source.publicKey())).toBe(false);
  expect(await tokenBalanceOf(pair, source.publicKey())).toBe(BigInt(0));
  expect(await tokenBalanceOf(shareToken, source.publicKey())).toBe(BigInt(0));
  await expect
    .poll(() => accountExists(source.publicKey()), { timeout: 30_000, intervals: [2_000] })
    .toBe(false);
});
