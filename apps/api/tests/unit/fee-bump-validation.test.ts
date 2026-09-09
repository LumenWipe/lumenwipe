import { describe, expect, test } from "bun:test";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { actsForOneAccount, isAllowedWindDownOperation } from "@/fee-bump/fee-bump-validation";

const SOURCE = Keypair.random().publicKey();
const OTHER = Keypair.random().publicKey();
const SIGNER = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const ASSET = new Asset("USDC", ISSUER);
// 8-hex-char type prefix + 64-hex-char value = 72, the shape the SDK's own builder validates.
const BALANCE_ID = "00000000" + "00".repeat(32);

/** Builds a one-operation transaction and returns its parsed operation, exactly the way the
 *  controller reads `tx.operations` off a real transaction. */
function operationOf(op: ReturnType<typeof Operation.payment>): Transaction["operations"][number] {
  const tx = new TransactionBuilder(new Account(SOURCE, "1"), {
    fee: "0",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();
  return tx.operations[0]!;
}

describe("isAllowedWindDownOperation", () => {
  test("allows every documented wind-down shape (architecture.md §8.1, threat-model.md §6)", () => {
    const allowed: Array<[string, ReturnType<typeof Operation.payment>]> = [
      ["changeTrust removal", Operation.changeTrust({ asset: ASSET, limit: "0" })],
      [
        "manageSellOffer cancellation",
        Operation.manageSellOffer({
          selling: ASSET,
          buying: Asset.native(),
          amount: "0",
          price: "1",
        }),
      ],
      [
        "manageBuyOffer cancellation",
        Operation.manageBuyOffer({
          selling: ASSET,
          buying: Asset.native(),
          buyAmount: "0",
          price: "1",
        }),
      ],
      ["manageData removal", Operation.manageData({ name: "x", value: null })],
      ["setOptions no-op", Operation.setOptions({ masterWeight: 1 })],
      [
        "setOptions signer removal",
        Operation.setOptions({ signer: { ed25519PublicKey: SIGNER, weight: 0 } }),
      ],
      ["claimClaimableBalance", Operation.claimClaimableBalance({ balanceId: BALANCE_ID })],
      [
        "pathPaymentStrictSend",
        Operation.pathPaymentStrictSend({
          sendAsset: ASSET,
          sendAmount: "10",
          destination: OTHER,
          destAsset: Asset.native(),
          destMin: "1",
        }),
      ],
      ["accountMerge", Operation.accountMerge({ destination: OTHER })],
    ];
    for (const [label, op] of allowed) {
      expect(isAllowedWindDownOperation(operationOf(op)), label).toBe(true);
    }
  });

  test("refuses opening or raising a trustline, not just removing one", () => {
    expect(
      isAllowedWindDownOperation(
        operationOf(Operation.changeTrust({ asset: ASSET, limit: "1000" }))
      )
    ).toBe(false);
    // The SDK's own default limit when none is given - still not a removal.
    expect(isAllowedWindDownOperation(operationOf(Operation.changeTrust({ asset: ASSET })))).toBe(
      false
    );
  });

  test("refuses placing or resizing an offer, on either offer type", () => {
    expect(
      isAllowedWindDownOperation(
        operationOf(
          Operation.manageSellOffer({
            selling: ASSET,
            buying: Asset.native(),
            amount: "5",
            price: "1",
          })
        )
      )
    ).toBe(false);
    expect(
      isAllowedWindDownOperation(
        operationOf(
          Operation.manageBuyOffer({
            selling: ASSET,
            buying: Asset.native(),
            buyAmount: "5",
            price: "1",
          })
        )
      )
    ).toBe(false);
  });

  test("refuses writing a data entry, not just removing one", () => {
    expect(
      isAllowedWindDownOperation(operationOf(Operation.manageData({ name: "x", value: "y" })))
    ).toBe(false);
  });

  test("refuses a payment or a Soroban invocation - operation types outside the allowlist entirely", () => {
    expect(
      isAllowedWindDownOperation(
        operationOf(Operation.payment({ destination: OTHER, asset: Asset.native(), amount: "1" }))
      )
    ).toBe(false);
    expect(
      isAllowedWindDownOperation(operationOf(Operation.bumpSequence({ bumpTo: "999999999999" })))
    ).toBe(false);
  });

  describe("SetOptions: signer normalization only", () => {
    test("an operation touching nothing at all is allowed - the SDK parses its unset fields as null, not undefined, for several of them", () => {
      expect(isAllowedWindDownOperation(operationOf(Operation.setOptions({})))).toBe(true);
    });

    test("refuses adding or empowering a signer", () => {
      expect(
        isAllowedWindDownOperation(
          operationOf(Operation.setOptions({ signer: { ed25519PublicKey: SIGNER, weight: 1 } }))
        )
      ).toBe(false);
    });

    test("refuses disabling the master key", () => {
      expect(
        isAllowedWindDownOperation(operationOf(Operation.setOptions({ masterWeight: 0 })))
      ).toBe(false);
    });

    test("allows lowering thresholds to the normalized 0/1/1, refuses raising any above 1", () => {
      expect(
        isAllowedWindDownOperation(
          operationOf(Operation.setOptions({ lowThreshold: 0, medThreshold: 1, highThreshold: 1 }))
        )
      ).toBe(true);
      for (const raised of [{ lowThreshold: 2 }, { medThreshold: 2 }, { highThreshold: 2 }]) {
        expect(isAllowedWindDownOperation(operationOf(Operation.setOptions(raised)))).toBe(false);
      }
    });

    test("refuses touching flags, the home domain, or the inflation destination", () => {
      for (const touched of [
        { setFlags: 1 },
        { clearFlags: 1 },
        { homeDomain: "example.com" },
        { inflationDest: OTHER },
      ]) {
        expect(isAllowedWindDownOperation(operationOf(Operation.setOptions(touched)))).toBe(false);
      }
    });
  });
});

describe("actsForOneAccount", () => {
  function txWith(...ops: ReturnType<typeof Operation.payment>[]): Transaction {
    const builder = new TransactionBuilder(new Account(SOURCE, "1"), {
      fee: "0",
      networkPassphrase: Networks.TESTNET,
    });
    for (const op of ops) builder.addOperation(op);
    return builder.setTimeout(30).build();
  }

  test("allows operations that leave their source unstated, or that restate the transaction's own", () => {
    expect(
      actsForOneAccount(
        txWith(
          Operation.accountMerge({ destination: OTHER }),
          Operation.accountMerge({ destination: OTHER, source: SOURCE })
        )
      )
    ).toBe(true);
  });

  test("refuses a transaction bundling an operation for a different account, even a wind-down-shaped one", () => {
    // Each operation alone is an allowed wind-down shape; only their sources differ. Without this
    // check, a caller could get the fee account to sponsor several unrelated accounts' operations
    // in one envelope, each passing isAllowedWindDownOperation in isolation.
    expect(
      actsForOneAccount(
        txWith(
          Operation.accountMerge({ destination: OTHER }),
          Operation.accountMerge({ destination: SOURCE, source: OTHER })
        )
      )
    ).toBe(false);
  });
});
