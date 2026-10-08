import { test, expect, describe } from "bun:test";
import {
  balanceFinding,
  forwardFinding,
  nativeBalanceStroops,
  parseServiceAccounts,
  type ServiceAccount,
} from "@/lib/monitors/service-accounts";

const MEDIATOR = "GC2VH6XP7HTOZHIX4OC3PU5HUXWY5XANGML4F6GBCNH5MBDFN5MU4WG7";
const SPONSOR = "GCMCGC6EJZKJJUTFY6RK43PGOODW6EL6FSHSLXBV4EYSZ3GHNJO3FXAP";
const USER = "GD27CZC3DRI2YPKIDXIEPMHVBWXSTOFO7HNK5OMIZBMS7N6UWUNM2SOP";

const mediator: ServiceAccount = {
  role: "mediator",
  network: "testnet",
  address: MEDIATOR,
  floorXlm: "1",
};

const tx = {
  hash: "86008a27".padEnd(64, "0"),
  created_at: "2026-08-17T22:59:09Z",
  source_account: USER,
};

describe("parseServiceAccounts", () => {
  test("accepts a well-formed list", () => {
    const parsed = parseServiceAccounts(
      JSON.stringify([
        { role: "mediator", network: "testnet", address: MEDIATOR, floorXlm: "1" },
        { role: "sponsor", network: "mainnet", address: SPONSOR, floorXlm: "50.5" },
      ])
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[1]).toEqual({
      role: "sponsor",
      network: "mainnet",
      address: SPONSOR,
      floorXlm: "50.5",
    });
  });

  test.each([
    ["not json", "nope"],
    ["an empty list", "[]"],
    [
      "an unknown role",
      JSON.stringify([{ role: "admin", network: "testnet", address: MEDIATOR, floorXlm: "1" }]),
    ],
    [
      "an unknown network",
      JSON.stringify([
        { role: "mediator", network: "futurenet", address: MEDIATOR, floorXlm: "1" },
      ]),
    ],
    [
      "a contract id as address",
      JSON.stringify([
        {
          role: "mediator",
          network: "testnet",
          address: "CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK",
          floorXlm: "1",
        },
      ]),
    ],
    [
      "a numeric floor",
      JSON.stringify([{ role: "mediator", network: "testnet", address: MEDIATOR, floorXlm: 1 }]),
    ],
    [
      "a floor with too many decimals",
      JSON.stringify([
        { role: "mediator", network: "testnet", address: MEDIATOR, floorXlm: "1.00000001" },
      ]),
    ],
  ])("rejects %s", (_label, json) => {
    expect(() => parseServiceAccounts(json)).toThrow();
  });
});

describe("balanceFinding", () => {
  const horizon = (balance: string) => ({
    balances: [
      { asset_type: "credit_alphanum4", balance: "999.0000000" },
      { asset_type: "native", balance },
    ],
  });

  test("reads the native balance, not the first balance", () => {
    expect(nativeBalanceStroops(horizon("10000.0000000"))).toBe(100_000_000_000n);
  });

  test("is quiet at or above the floor", () => {
    expect(balanceFinding(mediator, horizon("1.0000000"))).toBeNull();
    expect(balanceFinding(mediator, horizon("10000.0000000"))).toBeNull();
  });

  test("fires one stroop below the floor", () => {
    const finding = balanceFinding(mediator, horizon("0.9999999"));
    expect(finding?.message).toBe("native balance 0.9999999 XLM is below the 1 XLM floor");
  });

  test("fires when Horizon lists no native balance at all", () => {
    expect(balanceFinding(mediator, { balances: [] })?.message).toContain("no native balance");
  });
});

describe("forwardFinding", () => {
  const merge = (amount: string) => ({ type: "account_credited", account: MEDIATOR, amount });
  const forward = (amount: string) => ({ type: "account_debited", account: MEDIATOR, amount });

  test("a forward equal to the merge is the legitimate shape", () => {
    const effects = [
      { type: "account_removed", account: USER },
      merge("9999.9999800"),
      forward("9999.9999800"),
      { type: "account_credited", account: "GEXCHANGE", amount: "9999.9999800" },
    ];
    expect(forwardFinding(mediator, tx, effects)).toBeNull();
  });

  test("a forward one stroop above the merge fires", () => {
    const finding = forwardFinding(mediator, tx, [merge("100.0000000"), forward("100.0000001")]);
    expect(finding?.message).toContain("paid out 100.0000001 XLM but the merge delivered 100 XLM");
    expect(finding?.message).toContain(tx.hash);
  });

  test("a forward with no merge at all fires", () => {
    expect(forwardFinding(mediator, tx, [forward("5")])).not.toBeNull();
  });

  test("an operator top-up is only a credit and stays quiet", () => {
    expect(forwardFinding(mediator, tx, [merge("50")])).toBeNull();
  });

  test("effects on other accounts do not count", () => {
    const effects = [
      merge("10"),
      forward("10"),
      { type: "account_debited", account: USER, amount: "1000" },
    ];
    expect(forwardFinding(mediator, tx, effects)).toBeNull();
  });
});
