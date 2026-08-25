import { test, expect } from "bun:test";
import { operationToSceneAction } from "@/lib/scene-actions";
import type { IntentOperation } from "@lumenwipe/sdk";

const SOURCE = "GDEMO";

test("change_trust (removal) destroys the matching trustline node", () => {
  const op: IntentOperation = {
    type: "change_trust",
    source: SOURCE,
    asset: "AIRDROP1:GISSUER",
    limit: "0",
  };
  const action = operationToSceneAction(op, ["tl:AIRDROP1", "tl:LWDEMO"]);
  expect(action).toEqual({ type: "destroy", nodeIds: ["tl:AIRDROP1"] });
});

test("change_trust for a node not currently in the scene returns no action", () => {
  const op: IntentOperation = {
    type: "change_trust",
    source: SOURCE,
    asset: "AIRDROP1:GISSUER",
    limit: "0",
  };
  const action = operationToSceneAction(op, ["tl:LWDEMO"]);
  expect(action).toBeNull();
});

test("manage_data destroys the matching data node", () => {
  const op: IntentOperation = {
    type: "manage_data",
    source: SOURCE,
    name: "promo_code",
    value: null,
  };
  const action = operationToSceneAction(op, ["data:promo_code", "data:legacy_app_state"]);
  expect(action).toEqual({ type: "destroy", nodeIds: ["data:promo_code"] });
});

test("manage_sell_offer destroys every live offer node, not just one", () => {
  const op: IntentOperation = {
    type: "manage_sell_offer",
    source: SOURCE,
    offerId: "796919",
    amount: "0",
  };
  const action = operationToSceneAction(op, ["offer:0", "offer:1", "offer:2", "tl:LWDEMO"]);
  expect(action).toEqual({ type: "destroy", nodeIds: ["offer:0", "offer:1", "offer:2"] });
});

test("manage_sell_offer with no live offer nodes returns no action", () => {
  const op: IntentOperation = {
    type: "manage_sell_offer",
    source: SOURCE,
    offerId: "796919",
    amount: "0",
  };
  expect(operationToSceneAction(op, ["tl:LWDEMO"])).toBeNull();
});

test("set_options removing a signer destroys the extra-signer node", () => {
  const op: IntentOperation = {
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
  };
  const action = operationToSceneAction(op, ["signer:extra", "tl:LWDEMO"]);
  expect(action).toEqual({ type: "destroy", nodeIds: ["signer:extra"] });
});

test("set_options with a non-zero-weight signer (should never happen post-verify, but defensively) returns no action", () => {
  const op: IntentOperation = {
    type: "set_options",
    source: SOURCE,
    signer: { key: "GEXTRA", weight: 1, type: "ed25519_public_key" },
    masterWeight: null,
    lowThreshold: null,
    medThreshold: null,
    highThreshold: null,
    homeDomain: null,
    setFlags: null,
    clearFlags: null,
    inflationDest: null,
  };
  expect(operationToSceneAction(op, ["signer:extra"])).toBeNull();
});

test("set_options touching only thresholds (no signer) returns no action", () => {
  const op: IntentOperation = {
    type: "set_options",
    source: SOURCE,
    signer: null,
    masterWeight: null,
    lowThreshold: 0,
    medThreshold: 0,
    highThreshold: 0,
    homeDomain: null,
    setFlags: null,
    clearFlags: null,
    inflationDest: null,
  };
  expect(operationToSceneAction(op, ["signer:extra"])).toBeNull();
});

test("payment (issuer return) pulses the matching trustline node", () => {
  const op: IntentOperation = {
    type: "payment",
    source: SOURCE,
    destination: "GISSUER",
    asset: "AIRDROP1:GISSUER",
    amount: "1000000",
  };
  const action = operationToSceneAction(op, ["tl:AIRDROP1"]);
  expect(action).toEqual({ type: "pulse", nodeId: "tl:AIRDROP1" });
});

test("account_merge produces a merge action", () => {
  const op: IntentOperation = {
    type: "account_merge",
    source: SOURCE,
    destination: "GMM",
  };
  expect(operationToSceneAction(op, [])).toEqual({ type: "merge" });
});

test("unknown operation type returns no action", () => {
  const op: IntentOperation = { type: "unknown", source: SOURCE };
  expect(operationToSceneAction(op, ["tl:LWDEMO"])).toBeNull();
});

test("claim_claimable_balance returns no action (playground never creates one)", () => {
  const op: IntentOperation = {
    type: "claim_claimable_balance",
    source: SOURCE,
    balanceId: "abc",
  };
  expect(operationToSceneAction(op, [])).toBeNull();
});

test("revoke_sponsorship returns no action (no corresponding scene node)", () => {
  const op: IntentOperation = {
    type: "revoke_sponsorship",
    source: SOURCE,
    entryKind: "trustline",
    owner: SOURCE,
  };
  expect(operationToSceneAction(op, [])).toBeNull();
});

test("path_payment_strict_send (asset conversion) returns no action - the playground never chooses convert", () => {
  const op: IntentOperation = {
    type: "path_payment_strict_send",
    source: SOURCE,
    sendAsset: "AIRDROP1:GISSUER",
    sendAmount: "100",
    destination: SOURCE,
    destAsset: "native",
    destMin: "1",
    path: [],
  };
  expect(operationToSceneAction(op, ["tl:AIRDROP1"])).toBeNull();
});
