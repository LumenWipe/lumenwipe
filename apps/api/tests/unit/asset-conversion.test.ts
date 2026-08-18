import { test, expect } from "bun:test";
import { Account, Keypair, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  buildConvertAssetTx,
  buildSendToIssuerTx,
} from "@/lib/stellar/tx-builder/asset-conversion";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { BASE_FEE_STROOPS, TX_TIMEOUT_SECONDS } from "@/config/constants";
import type { Trustline, ConversionPath } from "@lumenwipe/types";

const MASTER = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();

const trustline: Trustline = {
  asset: `USDC:${ISSUER}`,
  balance: "100",
  authorized: true,
  issuer: ISSUER,
  code: "USDC",
};

test("buildConvertAssetTx > builds a single-operation path-payment transaction at double the base fee", () => {
  const path: ConversionPath = {
    fromAsset: `USDC:${ISSUER}`,
    toAsset: "native",
    // A non-empty hop, so the intermediate-asset mapping in assetConversionOp actually runs -
    // an empty path would never exercise it.
    path: [`EURC:${ISSUER}`],
    estimatedReceive: "99",
    destMin: "98",
  };
  const account = new Account(MASTER, "100");
  const xdr = buildConvertAssetTx(account, trustline, path, "testnet");

  const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASES.testnet) as Transaction;
  expect(tx.operations).toHaveLength(1);
  expect(tx.operations[0]!.type).toBe("pathPaymentStrictSend");
  expect(Number(tx.fee)).toBe(BASE_FEE_STROOPS * 2);
  expect(tx.timeBounds).toBeDefined();
  const maxTime = Number(tx.timeBounds!.maxTime);
  expect(maxTime).toBeGreaterThan(0);
  expect(maxTime).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + TX_TIMEOUT_SECONDS + 5);
});

test("buildSendToIssuerTx > builds a single-operation payment transaction at the base fee", () => {
  const account = new Account(MASTER, "100");
  const xdr = buildSendToIssuerTx(account, trustline, "testnet");

  const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASES.testnet);
  expect(tx.operations).toHaveLength(1);
  expect(tx.operations[0]!.type).toBe("payment");
  expect(Number(tx.fee)).toBe(BASE_FEE_STROOPS);
});
