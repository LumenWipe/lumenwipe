import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import { useKeepDecisions } from "@/hooks/useKeepDecisions";
import {
  DECISIONS_VERSION,
  readDecisions,
  type DecisionSnapshot,
} from "@/lib/session/decision-snapshot";
import { restoreAssetDecisions, snapshotOf } from "@/lib/session/restore-decisions";
import { isValidGAddress, isValidSecretKey } from "@/lib/utils/validation";
import { useDemolishStore } from "@/store/demolish";
import type { AccountState } from "@/types/account";

const SOURCE = Keypair.random().publicKey();
const PAYEE = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const USDC = `USDC:${ISSUER}`;
const AQUA = `AQUA:${ISSUER}`;
const EURC = `EURC:${ISSUER}`;
const BTC = `BTC:${ISSUER}`;
const ETH = `ETH:${ISSUER}`;
const KEY = `lumenwipe:decisions:testnet:${SOURCE}`;
// S-shaped but not a usable seed: the guard below proves it can never be a real one.
const S_SHAPED = "S" + "A".repeat(55);
const GARBAGE = "not an address";
// G-shaped but not addresses: a field halfway through typing, and one wrong character.
// Cut from another address: a prefix of PAYEE would match inside the PAYEE that is kept.
const HALF_TYPED = Keypair.random().publicKey().slice(0, 20);
const TYPO = PAYEE.slice(0, 28) + (PAYEE[28] === "A" ? "B" : "A") + PAYEE.slice(29);

function account(): AccountState {
  const line = (asset: string) => ({
    asset,
    balance: "5.0000000",
    limit: "1000",
    buyingLiabilities: "0",
    sellingLiabilities: "0",
  });
  return {
    address: SOURCE,
    trustlines: [line(USDC), line(AQUA), line(EURC), line(BTC), line(ETH)],
    claimableBalances: [],
  } as unknown as AccountState;
}

function transferTo(asset: string, destination: string): void {
  const state = useDemolishStore.getState();
  state.setAssetDisposition(asset, "transfer");
  state.setTransferDestination(asset, destination);
}

let fresh: ReturnType<typeof useDemolishStore.getState>;

beforeEach(() => {
  window.sessionStorage.clear();
  useDemolishStore.getState().reset();
  fresh = useDemolishStore.getState();
});

afterEach(() => cleanup());

test("the fixtures are what they claim to be", () => {
  expect(isValidSecretKey(S_SHAPED)).toBe(false);
  expect(isValidGAddress(S_SHAPED)).toBe(false);
  expect(isValidGAddress(GARBAGE)).toBe(false);
  expect(HALF_TYPED.startsWith("G")).toBe(true);
  expect(isValidGAddress(HALF_TYPED)).toBe(false);
  expect(TYPO.startsWith("G")).toBe(true);
  expect(TYPO).toHaveLength(PAYEE.length);
  expect(isValidGAddress(TYPO)).toBe(false);
  expect(isValidGAddress(PAYEE)).toBe(true);
});

test("a transfer destination that is not an account address is never written to the tab", () => {
  useDemolishStore.getState().setAccountState(account());
  renderHook(() => useKeepDecisions("testnet", SOURCE));

  act(() => {
    transferTo(USDC, PAYEE);
    transferTo(AQUA, S_SHAPED);
    transferTo(EURC, GARBAGE);
    transferTo(BTC, HALF_TYPED);
    transferTo(ETH, TYPO);
  });

  const saved = window.sessionStorage.getItem(KEY);
  expect(saved).not.toBeNull();
  expect(saved).not.toContain(S_SHAPED);
  expect(saved).not.toContain(GARBAGE);
  expect(saved).not.toContain(HALF_TYPED);
  expect(saved).not.toContain(TYPO);
  expect(JSON.parse(saved!).transferDestinations).toEqual({ [USDC]: PAYEE });
});

test("a well-formed transfer destination is kept and comes back after a reload", () => {
  useDemolishStore.getState().setAccountState(account());
  renderHook(() => useKeepDecisions("testnet", SOURCE));
  act(() => {
    transferTo(USDC, PAYEE);
    transferTo(AQUA, S_SHAPED);
    transferTo(BTC, HALF_TYPED);
    transferTo(ETH, TYPO);
  });
  // A reload: the store as the page first builds it, and this tab's storage.
  cleanup();
  useDemolishStore.setState(fresh, true);
  const read = readDecisions("testnet", SOURCE);
  expect(read.kind).toBe("restored");
  if (read.kind !== "restored") return;
  restoreAssetDecisions(read.snapshot, account());

  expect(useDemolishStore.getState().transferDestinations).toEqual({ [USDC]: PAYEE });
});

test("before the account is read, only well-formed destinations are carried over", () => {
  const previous: DecisionSnapshot = {
    v: DECISIONS_VERSION,
    network: "testnet",
    source: SOURCE,
    destination: null,
    memo: null,
    memoType: null,
    destinationAcknowledgedFor: null,
    assetDispositions: {
      [USDC]: "transfer",
      [AQUA]: "transfer",
      [EURC]: "transfer",
      [BTC]: "transfer",
      [ETH]: "transfer",
    },
    transferDestinations: {
      [USDC]: PAYEE,
      [AQUA]: S_SHAPED,
      [EURC]: GARBAGE,
      [BTC]: HALF_TYPED,
      [ETH]: TYPO,
    },
    claimableBalanceSelections: {},
    seen: {},
  };

  const snapshot = snapshotOf("testnet", SOURCE, useDemolishStore.getState(), previous);

  expect(snapshot.transferDestinations).toEqual({ [USDC]: PAYEE });
});
