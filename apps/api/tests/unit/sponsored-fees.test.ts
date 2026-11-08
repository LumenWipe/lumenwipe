import { describe, expect, test } from "bun:test";
import { Account, Keypair, Networks, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import type { AccountState, Trustline } from "@lumenwipe/types";
import { closeRoundSponsorable, packFees, type FeeChunk } from "@/lib/close-api/sponsored-fees";
import { isAllowedWindDownOperation, actsForOneAccount } from "@/fee-bump/fee-bump-validation";
import {
  assembleCloseOpsTagged,
  splitCloseOps,
  type AssetAction,
  type CloseOperationsInput,
} from "@/lib/stellar/tx-builder/close-operations";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { authorizationOf } from "./fixtures/trustline";

const MASTER = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const OWNER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const TRANSFER_TO = Keypair.random().publicKey();

function line(code: string, balance: string): Trustline {
  return {
    asset: `${code}:${ISSUER}`,
    balance,
    ...authorizationOf(true),
    issuer: ISSUER,
    code,
    limit: "1000",
  };
}

const LINES = [line("USDC", "10"), line("EURC", "5"), line("GBPC", "3"), line("ZERO", "0")];
const DISPOSITIONS = {
  [LINES[0]!.asset]: "convert",
  [LINES[1]!.asset]: "issuer",
  [LINES[2]!.asset]: "transfer",
};

function account(dataEntries: number): AccountState {
  return {
    address: MASTER,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: "100.0000000",
    dataEntries: Array.from({ length: dataEntries }, (_, i) => ({ key: `k${i}`, value: "dg==" })),
    signers: [
      { key: MASTER, weight: 2, type: "ed25519_public_key" },
      { key: Keypair.random().publicKey(), weight: 1, type: "ed25519_public_key" },
      { key: StrKey.encodeSha256Hash(Buffer.alloc(32, 1)), weight: 1, type: "hash_x" },
      { key: StrKey.encodePreAuthTx(Buffer.alloc(32, 2)), weight: 1, type: "preauth_tx" },
    ],
    thresholds: { low: 0, med: 1, high: 2 },
    numSubEntries: 0,
    numSponsoring: 0,
    sponsoredBy: null,
    authImmutable: false,
    trustlines: LINES,
    openOffers: [
      { id: "7", selling: "native", buying: LINES[0]!.asset, amount: "1.0000000", price: "1" },
    ],
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
    sponsoredEntries: [
      { kind: "trustline", owner: OWNER, asset: LINES[0]!.asset },
      { kind: "data_entry", owner: OWNER, name: "theirs" },
      { kind: "offer", owner: OWNER, offerId: "9" },
      { kind: "signer", owner: OWNER, signerKey: Keypair.random().publicKey() },
      { kind: "claimable_balance", balanceId: `00000000${"d".repeat(64)}` },
    ],
    sponsorshipEnumerationIncomplete: false,
    defiPositions: emptyDefiPositionsResult(MASTER),
    defiPositionsWarnings: [],
  };
}

function actions(): AssetAction[] {
  return [
    {
      trustline: LINES[0]!,
      action: "convert",
      path: {
        fromAsset: LINES[0]!.asset,
        toAsset: "native",
        path: [],
        estimatedReceive: "1",
        destMin: "1",
      },
    },
    { trustline: LINES[1]!, action: "issuer" },
    { trustline: LINES[2]!, action: "transfer", destination: TRANSFER_TO },
  ];
}

function inputFor(state: AccountState, includeMerge: boolean): CloseOperationsInput {
  return {
    needsSignerNormalization: true,
    signers: state.signers,
    revokeSponsorshipEntries: state.sponsoredEntries.filter((e) => e.kind !== "claimable_balance"),
    dataEntries: state.dataEntries,
    openOffers: state.openOffers,
    claimableBalances: [],
    trustlinesToAddForClaim: [],
    assetActions: actions(),
    trustlines: state.trustlines,
    destinationAddress: DEST,
    memo: null,
    memoType: null,
    includeMerge,
  };
}

/** Per operation, what the sponsor's own rule says, judged a transaction at a time as it is. */
function sponsorRule(input: CloseOperationsInput): { ops: boolean[]; chunks: boolean[] } {
  const ops: boolean[] = [];
  const chunks: boolean[] = [];
  for (const chunk of splitCloseOps(assembleCloseOpsTagged(MASTER, input))) {
    const builder = new TransactionBuilder(new Account(MASTER, "1"), {
      fee: "0",
      networkPassphrase: Networks.TESTNET,
    }).setTimeout(300);
    for (const t of chunk) builder.addOperation(t.op);
    const tx = builder.build();
    const allowed = tx.operations.map(isAllowedWindDownOperation);
    ops.push(...allowed);
    chunks.push(allowed.every(Boolean) && actsForOneAccount(tx));
  }
  return { ops, chunks };
}

describe("closeRoundSponsorable", () => {
  describe.each([
    { name: "a close under the operation cap", dataEntries: 1 },
    { name: "a close split across transactions", dataEntries: 110 },
  ])("for $name", ({ dataEntries }) => {
    test.each([
      { destination: "a wallet", viaMediator: false },
      { destination: "an exchange", viaMediator: true },
    ])(
      "into $destination, matches the sponsor's rule on the operations the build assembles",
      ({ viaMediator }) => {
        const state = account(dataEntries);
        const projected = closeRoundSponsorable(state, DISPOSITIONS, viaMediator, true);
        const rule = sponsorRule(inputFor(state, !viaMediator));

        expect(projected).toEqual(rule.ops);
        expect(splitCloseOps(projected).map((c) => c.every(Boolean))).toEqual(rule.chunks);
        expect(rule.ops).toContain(false);
        expect(rule.ops).toContain(true);
      }
    );
  });
});

/** The packing this replaces, kept as an oracle: the account pays any chunk it can afford. */
function greedySucceeds(spare: bigint, chunks: FeeChunk[]): boolean {
  let left = spare;
  for (const c of chunks) {
    if (left >= c.fee) left -= c.fee;
    else if (!c.sponsorable) return false;
  }
  return true;
}

function random(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

describe("packFees", () => {
  test("succeeds exactly when the spare covers the fees no sponsor pays, and wherever greedy packing did", () => {
    const next = random(819);
    for (let run = 0; run < 5000; run++) {
      const chunks: FeeChunk[] = Array.from({ length: Math.floor(next() * 6) }, () => ({
        fee: BigInt(100 * (1 + Math.floor(next() * 100))),
        sponsorable: next() < 0.6,
      }));
      const own = chunks.reduce((sum, c) => (c.sponsorable ? sum : sum + c.fee), 0n);
      const spare = BigInt(Math.floor(next() * Number(own + 2000n))) - 500n;
      const packing = packFees(spare, chunks, 0n);
      const succeeds = packing.shortStroops === 0n;

      expect(succeeds).toBe(own === 0n || spare >= own);
      if (greedySucceeds(spare, chunks)) expect(succeeds).toBe(true);
      if (!succeeds) expect(packing.shortStroops).toBe(own - spare);
      chunks.forEach((c, i) => {
        if (!c.sponsorable) expect(packing.sponsored[i]).toBe(false);
      });
      const paid = chunks.reduce((sum, c, i) => (packing.sponsored[i] ? sum : sum + c.fee), 0n);
      if (succeeds) expect(paid <= (spare > 0n ? spare : 0n)).toBe(true);
    }
  });

  test("keeps what later rounds need: a sponsorable fee is sponsored rather than taken from it", () => {
    const chunks = [{ fee: 200n, sponsorable: true }];
    expect(packFees(300n, chunks, 0n)).toEqual({ sponsored: [false], shortStroops: 0n });
    expect(packFees(300n, chunks, 300n)).toEqual({ sponsored: [true], shortStroops: 0n });
    expect(packFees(500n, chunks, 300n)).toEqual({ sponsored: [false], shortStroops: 0n });
    expect(packFees(299n, chunks, 300n).shortStroops).toBe(1n);
  });

  test("with nothing the account must pay, a spare below zero is not a shortfall", () => {
    expect(packFees(-5n, [{ fee: 100n, sponsorable: true }], 0n)).toEqual({
      sponsored: [true],
      shortStroops: 0n,
    });
  });
});
