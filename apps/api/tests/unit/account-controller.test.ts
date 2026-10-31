import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { HttpException } from "@nestjs/common";
import { Keypair } from "@stellar/stellar-sdk";
import { AccountController } from "@/account/account.controller";
import * as accountState from "@/lib/stellar/account-state";
import { AccountStateChangedError } from "@/lib/utils/errors";

const ADDRESS = Keypair.random().publicKey();

afterEach(() => {
  mock.restore();
});

test("an account that kept changing during the read is a 409 state_changed, not a 500", async () => {
  spyOn(accountState, "getAccountState").mockRejectedValue(
    new AccountStateChangedError("account reads spanned ledgers 100 to 110")
  );

  const failure = await new AccountController()
    .account("testnet", ADDRESS)
    .catch((e: unknown) => e);

  expect(failure).toBeInstanceOf(HttpException);
  expect((failure as HttpException).getStatus()).toBe(409);
  expect((failure as HttpException).getResponse()).toMatchObject({
    error: {
      code: "state_changed",
      message:
        "This account changed while it was being read. Nothing was submitted. Please try again.",
    },
  });
});
