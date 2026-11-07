import { expect, test } from "bun:test";
import { explorerAccountUrl, explorerTxUrl } from "@/config/networks";

const HASH = "a".repeat(64);
const ACCOUNT = "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37";

test("a transaction links to the explorer of the network it is on", () => {
  expect(explorerTxUrl("mainnet", HASH)).toBe(`https://stellar.expert/explorer/public/tx/${HASH}`);
  expect(explorerTxUrl("testnet", HASH)).toBe(`https://stellar.expert/explorer/testnet/tx/${HASH}`);
});

test("an account links to the explorer of the network it is on", () => {
  expect(explorerAccountUrl("mainnet", ACCOUNT)).toBe(
    `https://stellar.expert/explorer/public/account/${ACCOUNT}`
  );
  expect(explorerAccountUrl("testnet", ACCOUNT)).toBe(
    `https://stellar.expert/explorer/testnet/account/${ACCOUNT}`
  );
});
