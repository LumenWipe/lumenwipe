import { describe, test, expect } from "bun:test";
import {
  SCENE_HANDLERS,
  operationToSceneAction,
  type LiveNode,
  type SceneAction,
} from "@/lib/scene-actions";
import type { IntentOperation } from "@lumenwipe/sdk";
import { AQUARIUS, BLEND, PHOENIX, PINNED_ASSETS, SOROSWAP, XLM_SAC } from "@/lib/scenarios";

const SOURCE = "GDEMO";
const live = (...ids: string[]): LiveNode[] => ids.map((id) => ({ id }));

const setOptions = (
  signer: {
    key: string;
    weight: number;
    type: "ed25519_public_key" | "hash_x" | "preauth_tx";
  } | null
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
    path_payment_strict_send: { type: "pulse", nodeId: "tl:AIRDROP1" },
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
  expect(operationToSceneAction(SAMPLES.path_payment_strict_send, live("tl:LWDEMO"))).toBeNull();
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

test("a removed signer destroys a node of its own type, one per removal", () => {
  const nodes = live("signer:cosigner:1", "signer:cosigner:2", "signer:hashx", "signer:preauth");
  const removed = (type: "ed25519_public_key" | "hash_x" | "preauth_tx") =>
    operationToSceneAction(setOptions({ key: "K", weight: 0, type }), nodes);
  expect(removed("hash_x")).toEqual({ type: "destroy", nodeIds: ["signer:hashx"] });
  expect(removed("preauth_tx")).toEqual({ type: "destroy", nodeIds: ["signer:preauth"] });
  expect(removed("ed25519_public_key")).toEqual({
    type: "destroy",
    nodeIds: ["signer:cosigner:1"],
  });
  const second = operationToSceneAction(
    setOptions({ key: "K", weight: 0, type: "ed25519_public_key" }),
    live("signer:cosigner:2")
  );
  expect(second).toEqual({ type: "destroy", nodeIds: ["signer:cosigner:2"] });
  expect(
    operationToSceneAction(setOptions({ key: "K", weight: 0, type: "hash_x" }), live())
  ).toBeNull();
});

describe("the Soroswap position and its pinned asset", () => {
  const circle = `${PINNED_ASSETS["circle-usdc"].code}:${PINNED_ASSETS["circle-usdc"].issuer}`;
  const scene = live("tl:circle-usdc", "tl:USDC", "lp:soroswap");

  test("the exit through the router empties the pool's node, and nothing else does", () => {
    const exit = { ...SAMPLES.invoke_host_function, contract: SOROSWAP.router };
    expect(operationToSceneAction({ ...exit, function: "remove_liquidity" }, scene)).toEqual({
      type: "destroy",
      nodeIds: ["lp:soroswap"],
    });
    expect(
      operationToSceneAction({ ...exit, function: "swap_exact_tokens_for_tokens" }, scene)
    ).toBeNull();
    const elsewhere = { ...exit, contract: SOROSWAP.pair, function: "remove_liquidity" };
    expect(operationToSceneAction(elsewhere, scene)).toBeNull();
  });

  test("Circle's USDC has its own node, apart from the playground's USDC", () => {
    const removal = { ...SAMPLES.change_trust, asset: circle };
    expect(operationToSceneAction(removal, scene)).toEqual({
      type: "destroy",
      nodeIds: ["tl:circle-usdc"],
    });
    const playground = { ...SAMPLES.change_trust, asset: "USDC:GEPHEMERAL" };
    expect(operationToSceneAction(playground, scene)).toEqual({
      type: "destroy",
      nodeIds: ["tl:USDC"],
    });
  });
});

describe("the Aquarius position", () => {
  const scene = live("tl:circle-usdc", "lp:soroswap", "lp:aquarius");

  test("the withdraw on the pool empties the pool's node, and nothing else does", () => {
    const exit = { ...SAMPLES.invoke_host_function, contract: AQUARIUS.pool };
    expect(operationToSceneAction({ ...exit, function: "withdraw" }, scene)).toEqual({
      type: "destroy",
      nodeIds: ["lp:aquarius"],
    });
    expect(operationToSceneAction({ ...exit, function: "claim" }, scene)).toBeNull();
    const share = { ...exit, contract: AQUARIUS.shareToken, function: "withdraw" };
    expect(operationToSceneAction(share, scene)).toBeNull();
    const router = { ...exit, contract: AQUARIUS.router, function: "withdraw" };
    expect(operationToSceneAction(router, scene)).toBeNull();
  });
});

describe("the Blend position", () => {
  const scene = live("lend:blend", "lp:aquarius");
  // The intent renders a submit's requests as JSON, as apps/api/src/lib/stellar/intent does.
  const submit = (...types: number[]) => ({
    ...SAMPLES.invoke_host_function,
    contract: BLEND.pool,
    function: "submit",
    args: [
      SOURCE,
      SOURCE,
      SOURCE,
      JSON.stringify(
        types.map((t) => ({ address: XLM_SAC, amount: "200000000", request_type: t }))
      ),
    ],
  });

  test("the collateral's withdrawal empties the pool's node", () => {
    expect(operationToSceneAction(submit(3), scene)).toEqual({
      type: "destroy",
      nodeIds: ["lend:blend"],
    });
  });

  test("a repay before it leaves the node in place, with a pulse", () => {
    expect(operationToSceneAction(submit(5), scene)).toEqual({
      type: "pulse",
      nodeId: "lend:blend",
    });
    // A repay beside the withdrawal still empties it.
    expect(operationToSceneAction(submit(5, 3), scene)).toEqual({
      type: "destroy",
      nodeIds: ["lend:blend"],
    });
  });

  test("another function, another contract, or no node in the scene changes nothing", () => {
    expect(operationToSceneAction({ ...submit(3), function: "claim" }, scene)).toBeNull();
    expect(operationToSceneAction({ ...submit(3), contract: XLM_SAC }, scene)).toBeNull();
    expect(operationToSceneAction(submit(3), live("lp:aquarius"))).toBeNull();
    // Unreadable requests are not a repay: the node goes, as for any other exit on the pool.
    const garbled = { ...submit(3), args: [SOURCE, SOURCE, SOURCE, "not json"] };
    expect(operationToSceneAction(garbled, scene)).toEqual({
      type: "destroy",
      nodeIds: ["lend:blend"],
    });
  });
});

describe("the Phoenix position", () => {
  const scene = live("lp:phoenix", "lend:blend");
  const call = (contract: string, fn: string) => ({
    ...SAMPLES.invoke_host_function,
    contract,
    function: fn,
    args: [SOURCE, "1000"],
  });

  test("the pool's withdrawal empties the pool's node", () => {
    expect(operationToSceneAction(call(PHOENIX.pool, "withdraw_liquidity"), scene)).toEqual({
      type: "destroy",
      nodeIds: ["lp:phoenix"],
    });
  });

  test("an unbond before it leaves the node in place, with a pulse", () => {
    expect(operationToSceneAction(call(PHOENIX.stake, "unbond"), scene)).toEqual({
      type: "pulse",
      nodeId: "lp:phoenix",
    });
  });

  test("another function, another contract, or no node in the scene changes nothing", () => {
    expect(operationToSceneAction(call(PHOENIX.pool, "unbond"), scene)).toBeNull();
    expect(operationToSceneAction(call(PHOENIX.stake, "withdraw_liquidity"), scene)).toBeNull();
    expect(operationToSceneAction(call(PHOENIX.pool, "swap"), scene)).toBeNull();
    expect(operationToSceneAction(call(PHOENIX.shareToken, "transfer"), scene)).toBeNull();
    expect(
      operationToSceneAction(call(PHOENIX.pool, "withdraw_liquidity"), live("lend:blend"))
    ).toBeNull();
    expect(operationToSceneAction(call(PHOENIX.stake, "unbond"), live("lend:blend"))).toBeNull();
  });
});
