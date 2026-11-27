import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import type { AccountState, DecisionAnswer } from "@lumenwipe/types";
import * as readAccount from "@/lib/close-api/read-account";
import * as transferDestinations from "@/lib/close-api/transfer-destinations";
import { buildAccountPlan } from "@/lib/close-api/account-plan";
import { TRANSFER_CHOICE, decisionIdFor } from "@/lib/close-api/decisions";
import { PLAN_ERRORS, mapDomainError } from "@/lib/close-api/domain-errors";
import { ALL_ON } from "@/config/kill-switches";
import { UNSUPPORTED_ADDRESS_MESSAGES } from "@/lib/utils/validation";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { authorizationOf } from "./fixtures/trustline";
import { stubIssuance } from "./fixtures/issuance";
import { stubLedgerConfirmation } from "./fixtures/ledger-confirmation";
import { C_ADDRESS, G_ADDRESS, W_ADDRESS, tampered } from "./fixtures/contract-addresses";
import * as rpcModule from "@/lib/stellar/rpc";
import { fakeRpcServer } from "../support/rpc-server";
import { latestLedger } from "../support/rpc-fixtures";

const SOURCE = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const USDC = `USDC:${ISSUER}`;

beforeEach(() => {
  stubIssuance();
  stubLedgerConfirmation();
  spyOn(rpcModule, "getRpcServer").mockImplementation(() =>
    fakeRpcServer({ getLatestLedger: () => Promise.resolve(latestLedger(1000)) })
  );
  spyOn(readAccount, "readAccountState").mockResolvedValue(state());
});

afterEach(() => {
  mock.restore();
});

function state(): AccountState {
  return {
    address: SOURCE,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: "5.0000000",
    dataEntries: [],
    signers: [{ key: SOURCE, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 1, high: 1 },
    numSubEntries: 1,
    numSponsoring: 0,
    sponsoredBy: null,
    authImmutable: false,
    trustlines: [
      {
        asset: USDC,
        balance: "100.0000000",
        ...authorizationOf(true),
        issuer: ISSUER,
        code: "USDC",
        limit: "1000",
      },
    ],
    openOffers: [],
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    defiPositions: emptyDefiPositionsResult(SOURCE),
    defiPositionsWarnings: [],
  };
}

const transferTo = (destination: string): DecisionAnswer[] => [
  { id: decisionIdFor(USDC), choice: TRANSFER_CHOICE, params: { destination } },
];

for (const [name, address, addressType] of [
  ["muxed contract", W_ADDRESS, "muxed_contract"],
  ["contract", C_ADDRESS, "contract"],
] as const) {
  test(`the plan refuses a ${name} transfer destination by kind before reading the destination`, async () => {
    const validate = spyOn(transferDestinations, "validateTransferDestinations");

    const err = await buildAccountPlan(SOURCE, null, transferTo(address), "testnet", ALL_ON).catch(
      (e: unknown) => e
    );

    expect(mapDomainError(PLAN_ERRORS, err)).toEqual({
      code: "unsupported_address_type",
      status: 400,
      message: UNSUPPORTED_ADDRESS_MESSAGES[addressType],
      details: { addressType, decisionId: decisionIdFor(USDC) },
    });
    expect(validate).not.toHaveBeenCalled();
  });
}

test("the plan keeps a malformed transfer destination as an unanswered one, not a refusal", async () => {
  const validate = spyOn(transferDestinations, "validateTransferDestinations").mockResolvedValue(
    []
  );

  await buildAccountPlan(SOURCE, null, transferTo(tampered(W_ADDRESS)), "testnet", ALL_ON);

  expect(validate.mock.calls[0]?.[0]).toEqual({});
});

test("the plan hands an account transfer destination on to the live check", async () => {
  const validate = spyOn(transferDestinations, "validateTransferDestinations").mockResolvedValue(
    []
  );

  await buildAccountPlan(SOURCE, null, transferTo(G_ADDRESS), "testnet", ALL_ON);

  expect(validate.mock.calls[0]?.[0]).toEqual({ [USDC]: G_ADDRESS });
});
