import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import * as walletKit from "@/hooks/useWalletKitConnection";
import RevokeAllowanceModal from "@/components/allowances/RevokeAllowanceModal";
import type { Allowance } from "@/types/allowance";

function stubWalletKit(address: string | null = null): void {
  spyOn(walletKit, "useWalletKitConnection").mockImplementation(
    () =>
      ({
        address,
        connecting: false,
        error: null,
        networkMismatch: false,
        connect: async () => {},
        disconnect: async () => {},
      }) as unknown as ReturnType<typeof walletKit.useWalletKitConnection>
  );
}

afterEach(() => {
  mock.restore();
});

const OWNER_KP = Keypair.random();
const OWNER = OWNER_KP.publicKey();
const TOKEN = Address.contract(Buffer.alloc(32, 1)).toString();
const SPENDER = Address.contract(Buffer.alloc(32, 2)).toString();

function allowance(): Allowance {
  return {
    token: TOKEN,
    tokenSymbol: "XTAR",
    tokenDecimals: 7,
    spender: SPENDER,
    spenderProtocol: null,
    amount: "5000000",
    expirationLedger: null,
    sources: ["registry"],
  };
}

/** A real, well-formed unsigned `approve(owner, spender, 0, 0)` transaction with proper
 *  source-account authorization on the one operation - the shape a real assembled response from
 *  the API's build endpoint has. */
function realRevokeXdr(options: { token?: string; spender?: string; owner?: string } = {}): string {
  const token = options.token ?? TOKEN;
  const spender = options.spender ?? SPENDER;
  const owner = options.owner ?? OWNER;
  const args = [
    new Address(owner).toScVal(),
    new Address(spender).toScVal(),
    nativeToScVal(BigInt(0), { type: "i128" }),
    nativeToScVal(0, { type: "u32" }),
  ];
  const op = new Contract(token).call("approve", ...args);
  const built = new TransactionBuilder(new Account(owner, "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();
  const envelope = built.toEnvelope();
  const txOps = envelope.v1().tx().operations();
  const hostOp = txOps[0]!.body().invokeHostFunctionOp();
  const authEntry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(token).toScAddress(),
          functionName: "approve",
          args,
        })
      ),
      subInvocations: [],
    }),
  });
  txOps[0]!.body(
    xdr.OperationBody.invokeHostFunction(
      new xdr.InvokeHostFunctionOp({ hostFunction: hostOp.hostFunction(), auth: [authEntry] })
    )
  );
  return envelope.toXDR("base64");
}

function mockFetchSequence(responses: Array<{ status: number; body: unknown }>): void {
  let call = 0;
  globalThis.fetch = (async () => {
    const r = responses[Math.min(call, responses.length - 1)]!;
    call++;
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
}

test("RevokeAllowanceModal › shows the token, spender, and amount being revoked", () => {
  stubWalletKit();
  render(
    <RevokeAllowanceModal
      network="testnet"
      owner={OWNER}
      allowance={allowance()}
      onClose={() => {}}
      onRevoked={() => {}}
    />
  );

  expect(screen.getByText("Revoke this allowance")).toBeTruthy();
  expect(screen.getAllByText("XTAR").length).toBeGreaterThan(0);
  expect(screen.getByText("0.5")).toBeTruthy();
});

test("RevokeAllowanceModal › the confirm button is disabled until a valid secret key is entered", () => {
  stubWalletKit();
  render(
    <RevokeAllowanceModal
      network="testnet"
      owner={OWNER}
      allowance={allowance()}
      onClose={() => {}}
      onRevoked={() => {}}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: /secret key/i }));
  const confirmButton = screen.getByRole("button", {
    name: /revoke allowance/i,
  }) as HTMLButtonElement;
  expect(confirmButton.disabled).toBe(true);

  fireEvent.change(screen.getByPlaceholderText("S..."), {
    target: { value: OWNER_KP.secret() },
  });
  expect(confirmButton.disabled).toBe(false);
});

test("RevokeAllowanceModal › the full build-verify-sign-submit flow completes and calls onRevoked", async () => {
  stubWalletKit();
  mockFetchSequence([
    { status: 200, body: { transaction: realRevokeXdr() } },
    { status: 200, body: { hash: "abc123", ledger: 42 } },
  ]);

  const onRevoked = mock((_a: Allowance) => {});
  render(
    <RevokeAllowanceModal
      network="testnet"
      owner={OWNER}
      allowance={allowance()}
      onClose={() => {}}
      onRevoked={onRevoked}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: /secret key/i }));
  fireEvent.change(screen.getByPlaceholderText("S..."), {
    target: { value: OWNER_KP.secret() },
  });
  fireEvent.click(screen.getByRole("button", { name: /revoke allowance/i }));

  await waitFor(() => expect(onRevoked).toHaveBeenCalledTimes(1));
  expect(screen.getByText("Allowance revoked")).toBeTruthy();
});

test("RevokeAllowanceModal › a response that revokes a different spender is rejected before signing, not submitted", async () => {
  stubWalletKit();
  const attackerSpender = Address.contract(Buffer.alloc(32, 9)).toString();
  let submitCalled = false;
  globalThis.fetch = (async (url: string) => {
    if (url.includes("/submit")) {
      submitCalled = true;
      return new Response(JSON.stringify({ hash: "x", ledger: 1 }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ transaction: realRevokeXdr({ spender: attackerSpender }) }),
      { status: 200 }
    );
  }) as unknown as typeof fetch;

  const onRevoked = mock((_a: Allowance) => {});
  render(
    <RevokeAllowanceModal
      network="testnet"
      owner={OWNER}
      allowance={allowance()}
      onClose={() => {}}
      onRevoked={onRevoked}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: /secret key/i }));
  fireEvent.change(screen.getByPlaceholderText("S..."), {
    target: { value: OWNER_KP.secret() },
  });
  fireEvent.click(screen.getByRole("button", { name: /revoke allowance/i }));

  await waitFor(() => expect(screen.getByText(/revoke the expected spender/i)).toBeTruthy());
  expect(onRevoked).not.toHaveBeenCalled();
  expect(submitCalled).toBe(false);
});

test("RevokeAllowanceModal › a connected wallet that doesn't match the owner shows a mismatch warning and disables confirm", () => {
  const other = Keypair.random().publicKey();
  stubWalletKit(other);
  render(
    <RevokeAllowanceModal
      network="testnet"
      owner={OWNER}
      allowance={allowance()}
      onClose={() => {}}
      onRevoked={() => {}}
    />
  );

  expect(screen.getByText(/doesn't match this account/i)).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: /revoke allowance/i }) as HTMLButtonElement).disabled
  ).toBe(true);
});
