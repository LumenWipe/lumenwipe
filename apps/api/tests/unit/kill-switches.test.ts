import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import * as feeAccount from "@/lib/stellar/fee-account";
import { EXIT_FLAGS, flagOn, isMalformedFlag, readKillSwitches } from "@/config/kill-switches";

const NAMES = [
  "FEE_SPONSORSHIP_ENABLED",
  "MEDIATOR_FORWARD_ENABLED",
  ...EXIT_FLAGS.map((f) => f.name),
] as const;
const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
const configured = (): boolean => true;

afterEach(() => {
  mock.restore();
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

test("an unset or empty switch is on, so a missing variable never turns a path off", () => {
  const switches = readKillSwitches("testnet", {}, configured);
  expect(switches.feeSponsorship).toBe(true);
  expect(switches.mediatorForward).toBe(true);
  expect([...switches.pausedExits]).toEqual([]);
  expect(flagOn(undefined)).toBe(true);
  expect(flagOn("")).toBe(true);
  expect(flagOn("true")).toBe(true);
});

test("only false turns a switch off, whatever its case or surrounding spaces", () => {
  expect(flagOn("false")).toBe(false);
  expect(flagOn(" FALSE ")).toBe(false);
  const switches = readKillSwitches(
    "testnet",
    { FEE_SPONSORSHIP_ENABLED: "false", MEDIATOR_FORWARD_ENABLED: "False" },
    configured
  );
  expect(switches.feeSponsorship).toBe(false);
  expect(switches.mediatorForward).toBe(false);
});

test("each protocol's exit switch pauses that protocol alone", () => {
  for (const { protocol, name } of EXIT_FLAGS) {
    const switches = readKillSwitches("testnet", { [name]: "false" }, configured);
    expect([...switches.pausedExits]).toEqual([protocol]);
  }
});

test("the conversion switches keep their opt-in meaning: off unless set to true", () => {
  expect(readKillSwitches("testnet", {}, configured)).toMatchObject({
    sorobanConversion: false,
    xbullConversion: false,
  });
  expect(
    readKillSwitches(
      "testnet",
      {
        SOROBAN_CONVERSION_ENABLED: "true",
        SOROSWAP_API_KEY: "sk_test",
        XBULL_CONVERSION_ENABLED: "true",
      },
      configured
    )
  ).toMatchObject({ sorobanConversion: true, xbullConversion: true });
  expect(
    readKillSwitches("testnet", { SOROBAN_CONVERSION_ENABLED: "true" }, configured)
      .sorobanConversion
  ).toBe(false);
});

test("the relay account counts as configured only when its key is", () => {
  expect(readKillSwitches("mainnet", {}, (n) => n === "testnet").mediatorConfigured).toBe(false);
  expect(readKillSwitches("testnet", {}, (n) => n === "testnet").mediatorConfigured).toBe(true);
});

test("the fee sponsor counts as configured only on the network its key is set for", () => {
  const onTestnet = (n: string): boolean => n === "testnet";
  expect(readKillSwitches("mainnet", {}, configured, onTestnet).feeSponsorConfigured).toBe(false);
  expect(readKillSwitches("testnet", {}, configured, onTestnet).feeSponsorConfigured).toBe(true);
});

test("by default the fee sponsor is configured when its keypair can be read", () => {
  const keypair = spyOn(feeAccount, "getFeeAccountKeypair").mockReturnValue(null);
  expect(readKillSwitches("testnet", {}, configured).feeSponsorConfigured).toBe(false);
  keypair.mockReturnValue(Keypair.random());
  expect(readKillSwitches("testnet", {}, configured).feeSponsorConfigured).toBe(true);
});

test("each call reads the environment again, so a flip shows on the next request", () => {
  delete process.env.FEE_SPONSORSHIP_ENABLED;
  delete process.env.SOROSWAP_EXIT_ENABLED;
  expect(readKillSwitches("testnet").feeSponsorship).toBe(true);
  expect(readKillSwitches("testnet").pausedExits.has("soroswap")).toBe(false);

  process.env.FEE_SPONSORSHIP_ENABLED = "false";
  process.env.SOROSWAP_EXIT_ENABLED = "false";
  expect(readKillSwitches("testnet").feeSponsorship).toBe(false);
  expect(readKillSwitches("testnet").pausedExits.has("soroswap")).toBe(true);

  process.env.FEE_SPONSORSHIP_ENABLED = "true";
  expect(readKillSwitches("testnet").feeSponsorship).toBe(true);
});

test("a value that is neither true nor false is malformed", () => {
  for (const value of [undefined, "", " ", "true", "FALSE", " false "]) {
    expect(isMalformedFlag(value)).toBe(false);
  }
  for (const value of ["0", "1", "no", "off", "fasle"]) {
    expect(isMalformedFlag(value)).toBe(true);
  }
});
