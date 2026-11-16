import {
  Account,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  rpc,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";

const ZERO_HASH = new Uint8Array(32);

function ledgerHeader(sequence: number, closeTime: bigint): xdr.LedgerHeader {
  return new xdr.LedgerHeader({
    ledgerVersion: 23,
    previousLedgerHash: ZERO_HASH,
    scpValue: new xdr.StellarValue({
      txSetHash: ZERO_HASH,
      closeTime,
      upgrades: [],
      ext: xdr.StellarValueExt.stellarValueBasic(),
    }),
    txSetResultHash: ZERO_HASH,
    bucketListHash: ZERO_HASH,
    ledgerSeq: sequence,
    totalCoins: 0n,
    feePool: 0n,
    inflationSeq: 0,
    idPool: 0n,
    baseFee: 100,
    baseReserve: 5_000_000,
    maxTxSetSize: 100,
    skipList: [ZERO_HASH, ZERO_HASH, ZERO_HASH, ZERO_HASH],
    ext: xdr.LedgerHeaderExt.v0(),
  });
}

/** A getLatestLedger answer for `sequence`, closed at `closeTime` (unix seconds). */
export function latestLedger(sequence: number, closeTime = 0): rpc.Api.GetLatestLedgerResponse {
  const header = ledgerHeader(sequence, BigInt(closeTime));
  return {
    id: String(sequence),
    sequence,
    protocolVersion: "23",
    closeTime: String(closeTime),
    headerXdr: header,
    metadataXdr: xdr.LedgerCloseMeta.v0(
      new xdr.LedgerCloseMetaV0({
        ledgerHeader: new xdr.LedgerHeaderHistoryEntry({
          hash: ZERO_HASH,
          header,
          ext: xdr.LedgerHeaderHistoryEntryExt.v0(),
        }),
        txSet: new xdr.TransactionSet({ previousLedgerHash: ZERO_HASH, txs: [] }),
        txProcessing: [],
        upgradesProcessing: [],
        scpInfo: [],
      })
    ),
  };
}

/** A sendTransaction answer with `status`. */
export function sendResult(
  status: rpc.Api.SendTransactionStatus,
  hash = "0".repeat(64)
): rpc.Api.SendTransactionResponse {
  return { status, hash, latestLedger: 1, latestLedgerCloseTime: 0 };
}

/** A getTransaction answer for a hash the node does not know. */
export function missingTransaction(txHash = "0".repeat(64)): rpc.Api.GetMissingTransactionResponse {
  return {
    status: rpc.Api.GetTransactionStatus.NOT_FOUND,
    txHash,
    latestLedger: 1,
    latestLedgerCloseTime: 0,
    oldestLedger: 1,
    oldestLedgerCloseTime: 0,
  };
}

/** A simulateTransaction answer that failed with `error`. */
export function simulationError(
  error = "simulation failed"
): rpc.Api.SimulateTransactionErrorResponse {
  return { id: "1", latestLedger: 1, events: [], _parsed: true, error };
}

/** A testnet transaction with a single bumpSequence from a random account. */
export function sampleTransaction(): Transaction {
  return new TransactionBuilder(new Account(Keypair.random().publicKey(), "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: "101" }))
    .setTimeout(30)
    .build();
}
