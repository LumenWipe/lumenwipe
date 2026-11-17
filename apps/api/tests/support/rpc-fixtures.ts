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

/** A getHealth answer at `sequence`, closed at `closeTime` (unix seconds), as RPC sends it. */
export function healthAnswer(
  sequence: number,
  closeTime = 1_700_000_000
): rpc.Api.GetHealthResponse & { latestLedgerCloseTime: string } {
  return {
    status: "healthy",
    latestLedger: sequence,
    latestLedgerCloseTime: String(closeTime),
    oldestLedger: Math.max(1, sequence - 120_960),
    ledgerRetentionWindow: 120_960,
  };
}

/** A getEvents page holding `events`, continued from `cursor`. */
export function eventsPage(
  events: rpc.Api.EventResponse[],
  cursor: string,
  latestLedger: number
): rpc.Api.GetEventsResponse {
  return {
    events,
    cursor,
    latestLedger,
    oldestLedger: 1,
    latestLedgerCloseTime: "0",
    oldestLedgerCloseTime: "0",
  };
}

/** A getHealth answer from a node that is serving. */
export function healthy(): rpc.Api.GetHealthResponse {
  return { status: "healthy", latestLedger: 1000, oldestLedger: 1, ledgerRetentionWindow: 999 };
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

interface LandedTransaction {
  envelope?: xdr.TransactionEnvelope;
  result?: xdr.TransactionResult;
  ledger?: number;
  createdAt?: number;
  txHash?: string;
}

function transactionResult(success: boolean): xdr.TransactionResult {
  return new xdr.TransactionResult({
    feeCharged: 100n,
    result: success
      ? xdr.TransactionResultResult.txSuccess([])
      : xdr.TransactionResultResult.txFailed([]),
    ext: xdr.TransactionResultExt.v0(),
  });
}

function landed(success: boolean, landing: LandedTransaction) {
  return {
    txHash: landing.txHash ?? "0".repeat(64),
    latestLedger: (landing.ledger ?? 1) + 1,
    latestLedgerCloseTime: 0,
    oldestLedger: 1,
    oldestLedgerCloseTime: 0,
    ledger: landing.ledger ?? 1,
    createdAt: landing.createdAt ?? 0,
    applicationOrder: 1,
    feeBump: false,
    envelopeXdr: landing.envelope ?? sampleTransaction().toEnvelope(),
    resultXdr: landing.result ?? transactionResult(success),
    resultMetaXdr: xdr.TransactionMeta.operations([]),
    events: { transactionEventsXdr: [], contractEventsXdr: [] },
  };
}

/** A getTransaction answer for a transaction that landed and succeeded. */
export function successfulTransaction(
  landing: LandedTransaction = {}
): rpc.Api.GetSuccessfulTransactionResponse {
  return { ...landed(true, landing), status: rpc.Api.GetTransactionStatus.SUCCESS };
}

/** A getTransaction answer for a transaction that landed and failed. */
export function failedTransaction(
  landing: LandedTransaction = {}
): rpc.Api.GetFailedTransactionResponse {
  return { ...landed(false, landing), status: rpc.Api.GetTransactionStatus.FAILED };
}

/** A simulateTransaction answer that failed with `error`. */
export function simulationError(
  error = "simulation failed"
): rpc.Api.SimulateTransactionErrorResponse {
  return { id: "1", latestLedger: 1, events: [], _parsed: true, error };
}

/** A simulateTransaction answer parsed from the wire shape the node sends, as `rpc.Server` returns it. */
export function simulation(
  raw: Omit<rpc.Api.RawSimulateTransactionResponse, "id" | "latestLedger">
): rpc.Api.SimulateTransactionResponse {
  return rpc.parseRawSimulation({ id: "1", latestLedger: 1, ...raw });
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
