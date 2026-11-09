import { describe, test, expect } from "bun:test";
import {
  SCENE_HANDLERS,
  operationToSceneAction,
  type LiveNode,
  type SceneAction,
} from "@/lib/scene-actions";
import type { IntentOperation } from "@lumenwipe/sdk";

const SOURCE = "GDEMO";
const live = (...ids: string[]): LiveNode[] => ids.map((id) => ({ id }));

const setOptions = (
  signer: { key: string; weight: number; type: "ed25519_public_key" } | null
): IntentOperation => ({
  type: "set_options",
  source: SOURCE,
  signer,
  masterWeight: null,
  lowThreshold: signer ? null : 0,
  medThreshold: signer ? null : 0,
  highThreshold: signer ? null : 0,
  homeDomain: null,
  setFlags: null,
  clearFlags: null,
  inflationDest: null,
});

/** One operation of every close operation type: the record's type fails to compile without each. */
const SAMPLES: { [T in IntentOperation["type"]]: Extract<IntentOperation, { type: T }> } = {
  change_trust: { type: "change_trust", source: SOURCE, asset: "AIRDROP1:GISSUER", limit: "0" },
  manage_data: { type: "manage_data", source: SOURCE, name: "promo_code", value: null },
  manage_sell_offer: { type: "manage_sell_offer", source: SOURCE, offerId: "12", amount: "0" },
  set_options: {
    type: "set_options",
    source: SOURCE,
    signer: { key: "GEXTRA", weight: 0, type: "ed25519_public_key" },
    masterWeight: null,
    lowThreshold: null,
    medThreshold: null,
    highThreshold: null,
    homeDomain: null,
    setFlags: null,
    clearFlags: null,
    inflationDest: null,
  },
  payment: {
    type: "payment",
    source: SOURCE,
    destination: "GISSUER",
    asset: "AIRDROP1:GISSUER",
    amount: "5",
  },
  account_merge: { type: "account_merge", source: SOURCE, destination: "GMM" },
  path_payment_strict_send: {
    type: "path_payment_strict_send",
    source: SOURCE,
    sendAsset: "AIRDROP1:GISSUER",
    sendAmount: "100",
    destination: SOURCE,
    destAsset: "native",
    destMin: "1",
    path: [],
  },
  claim_claimable_balance: { type: "claim_claimable_balance", source: SOURCE, balanceId: "abc" },
  revoke_sponsorship: {
    type: "revoke_sponsorship",
    source: SOURCE,
    entryKind: "trustline",
    owner: SOURCE,
  },
  invoke_host_function: {
    type: "invoke_host_function",
    source: SOURCE,
    contract: "CCONTRACT",
    function: "withdraw",
    args: [],
    accountsReferenced: [],
    contractsReferenced: [],
    unsupportedAddressCount: 0,
    authorizesBeyondSelf: false,
    authDepth: 0,
    subInvocations: [],
  },
  unknown: { type: "unknown", source: SOURCE },
};

describe("every close operation type has a decided scene action", () => {
  const scene: LiveNode[] = [
    ...live("tl:AIRDROP1", "data:promo_code", "signer:extra"),
    { id: "offer:1", offerId: "12" },
  ];
  const expected: Record<IntentOperation["type"], SceneAction | null> = {
    change_trust: { type: "destroy", nodeIds: ["tl:AIRDROP1"] },
    manage_data: { type: "destroy", nodeIds: ["data:promo_code"] },
    manage_sell_offer: { type: "destroy", nodeIds: ["offer:1"] },
    set_options: { type: "destroy", nodeIds: ["signer:extra"] },
    payment: { type: "pulse", nodeId: "tl:AIRDROP1" },
    account_merge: { type: "merge" },
    path_payment_strict_send: null,
    claim_claimable_balance: null,
    revoke_sponsorship: null,
    invoke_host_function: null,
    unknown: null,
  };
  for (const [type, op] of Object.entries(SAMPLES)) {
    test(type, () => {
      expect(operationToSceneAction(op, scene)).toEqual(expected[op.type]);
    });
  }

  test("the handler record covers exactly the operation types", () => {
    expect(Object.keys(SCENE_HANDLERS).sort()).toEqual(Object.keys(SAMPLES).sort());
  });
});

test("an operation whose node is not in the scene returns no action", () => {
  expect(operationToSceneAction(SAMPLES.change_trust, live("tl:LWDEMO"))).toBeNull();
  expect(operationToSceneAction(SAMPLES.manage_data, live("data:kyc_status"))).toBeNull();
  expect(operationToSceneAction(SAMPLES.payment, live("tl:LWDEMO"))).toBeNull();
  expect(operationToSceneAction(SAMPLES.set_options, live("tl:LWDEMO"))).toBeNull();
});

test("cancelling one offer destroys only the node bound to that offer id", () => {
  const scene: LiveNode[] = [
    { id: "offer:0", offerId: "11" },
    { id: "offer:1", offerId: "12" },
    { id: "offer:2", offerId: null },
  ];
  expect(operationToSceneAction(SAMPLES.manage_sell_offer, scene)).toEqual({
    type: "destroy",
    nodeIds: ["offer:1"],
  });
  expect(operationToSceneAction({ ...SAMPLES.manage_sell_offer, offerId: "99" }, scene)).toBeNull();
});

test("set_options only destroys the signer node when it removes a signer", () => {
  const added = setOptions({ key: "GEXTRA", weight: 1, type: "ed25519_public_key" });
  expect(operationToSceneAction(added, live("signer:extra"))).toBeNull();
  expect(operationToSceneAction(setOptions(null), live("signer:extra"))).toBeNull();
});
