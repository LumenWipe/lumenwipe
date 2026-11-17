import type {
  AccountSigner,
  AccountState,
  CloseTransaction,
  TransactionsResponse,
  TxIntent,
} from "@lumenwipe/types";

/** A transaction with no operations or guarantees unless a test sets them. */
export function closeTransaction(overrides: Partial<CloseTransaction> = {}): CloseTransaction {
  const intent: TxIntent = {
    summary: "",
    source: "",
    fee: "100",
    memo: null,
    memoType: null,
    guarantees: { mergeDestination: null, paymentsOnlyTo: [], minXlmFromConversions: null },
    operations: [],
  };
  return {
    id: "tx",
    order: 0,
    dependsOn: [],
    xdr: "",
    networkPassphrase: "Test SDF Network ; September 2015",
    sourceSequence: "1",
    validUntilLedger: 0,
    covers: [],
    intent,
    ...overrides,
  };
}

/** A ready round of these transactions. */
export function transactionsResponse(
  transactions: CloseTransaction[],
  overrides: Partial<TransactionsResponse> = {}
): TransactionsResponse {
  return {
    planHash: "h",
    status: "ready",
    transactions,
    remaining: { steps: 0, requiresAnotherCall: false },
    ...overrides,
  };
}

/** An account holding only its native balance, with no entries, signers or positions. */
export function accountState(address: string, overrides: Partial<AccountState> = {}): AccountState {
  return {
    address,
    network: "testnet",
    sequence: "1",
    nativeBalanceLumens: "0",
    dataEntries: [],
    signers: [],
    thresholds: { low: 0, med: 0, high: 0 },
    numSubEntries: 0,
    numSponsoring: 0,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    sponsoredBy: null,
    authImmutable: false,
    trustlines: [],
    openOffers: [],
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
    defiPositions: {
      address,
      network: "testnet",
      positions: [],
      unrecognizedPositions: [],
      enrichment: {},
      source: "empty",
      timestamp: null,
      queryKeys: {
        rpcEndpoints: [],
        rpcPolicy: {
          maxKeysPerCall: 0,
          recommendedConcurrency: 0,
          backoffOn429Ms: [],
          timeoutMs: 0,
        },
        slices: {},
      },
    },
    defiPositionsWarnings: [],
    ...overrides,
  };
}

const SIGNER_TYPES: readonly AccountSigner["type"][] = [
  "ed25519_public_key",
  "hash_x",
  "preauth_tx",
  "ed25519_signed_payload",
];

/** A signer read from JSON, whose `type` only widens to string. */
export function accountSigner(signer: {
  key: string;
  weight: number;
  type: string;
}): AccountSigner {
  const type = SIGNER_TYPES.find((known) => known === signer.type);
  if (type === undefined) throw new Error(`Unknown signer type ${signer.type}`);
  return { key: signer.key, weight: signer.weight, type };
}
