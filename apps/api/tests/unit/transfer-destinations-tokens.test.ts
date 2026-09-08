import { expect, test } from "bun:test";
import { Address, Keypair } from "@stellar/stellar-sdk";
import type { Trustline } from "@lumenwipe/types";
import { validateTransferDestinations } from "@/lib/close-api/transfer-destinations";

// A Soroban token has no trustline for the destination to hold: any existing account can receive
// it. What is still refused: the account being closed, an exchange deposit address (no memo can
// travel with a token transfer), and an account that does not exist.

const SOURCE = Keypair.random().publicKey();
const EXISTING = Keypair.random().publicKey();
const MISSING = Keypair.random().publicKey();
const TOKEN = Address.contract(Buffer.alloc(32, 3)).toString();
// A deposit address the bundled registry knows.
const EXCHANGE = "GB5CLRWUCBQ6DFK2LR5ZMWJ7QCVEB3XKMPTQUYCDIYB4DRZJBEW6M26D";

const readAccount = async (address: string): Promise<{ trustlines: Trustline[] } | null> =>
  address === EXISTING ? { trustlines: [] } : null;

test("an existing account can receive a token with no trustline check at all", async () => {
  const problems = await validateTransferDestinations(
    { [TOKEN]: EXISTING },
    [],
    SOURCE,
    "testnet",
    readAccount
  );
  expect(problems).toEqual([]);
});

test("the account being closed, an exchange, and a missing account are each refused with the reason", async () => {
  const toSelf = await validateTransferDestinations(
    { [TOKEN]: SOURCE },
    [],
    SOURCE,
    "testnet",
    readAccount
  );
  expect(toSelf.map((p) => p.code)).toEqual(["destination_is_source"]);

  const toExchange = await validateTransferDestinations(
    { [TOKEN]: EXCHANGE },
    [],
    SOURCE,
    "testnet",
    readAccount
  );
  expect(toExchange.map((p) => p.code)).toEqual(["destination_is_exchange"]);
  expect(toExchange[0]!.message).toContain("deposit memo");

  const toNobody = await validateTransferDestinations(
    { [TOKEN]: MISSING },
    [],
    SOURCE,
    "testnet",
    readAccount
  );
  expect(toNobody.map((p) => p.code)).toEqual(["token_destination_missing"]);
});
