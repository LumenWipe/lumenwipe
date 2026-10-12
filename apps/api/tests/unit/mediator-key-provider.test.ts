import { afterEach, beforeEach, expect, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import { getMediatorPublicKey } from "@/config/networks";
import { defaultMediatorKeyProvider } from "@/common/ports";

const SAVED = process.env.MEDIATOR_SECRET_TESTNET;

beforeEach(() => {
  delete process.env.MEDIATOR_SECRET_TESTNET;
});

afterEach(() => {
  if (SAVED === undefined) delete process.env.MEDIATOR_SECRET_TESTNET;
  else process.env.MEDIATOR_SECRET_TESTNET = SAVED;
});

test("the default provider reads the mediator secret from the environment on every call", () => {
  expect(defaultMediatorKeyProvider.keypair("testnet")).toBeNull();

  const first = Keypair.random();
  process.env.MEDIATOR_SECRET_TESTNET = first.secret();
  expect(defaultMediatorKeyProvider.keypair("testnet")?.publicKey()).toBe(first.publicKey());

  const second = Keypair.random();
  process.env.MEDIATOR_SECRET_TESTNET = second.secret();
  expect(defaultMediatorKeyProvider.keypair("testnet")?.publicKey()).toBe(second.publicKey());

  delete process.env.MEDIATOR_SECRET_TESTNET;
  expect(defaultMediatorKeyProvider.keypair("testnet")).toBeNull();
});

test("the default provider reports the configured public key as the network config does", () => {
  expect(defaultMediatorKeyProvider.configuredPublicKey("testnet")).toBe(
    getMediatorPublicKey("testnet")
  );
  expect(defaultMediatorKeyProvider.configuredPublicKey("mainnet")).toBe(
    getMediatorPublicKey("mainnet")
  );
});
