import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import * as walletKit from "@/hooks/useWalletKitConnection";
import * as recovery from "@/lib/session/recovery";
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
const TOKEN = Address.contract(new Uint8Array(32).fill(1)).toString();
const SPENDER = Address.contract(new Uint8Array(32).fill(2)).toString();

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
  const op = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(token).toScAddress(),
        functionName: "approve",
        args,
      })
    ),
    auth: [authEntry],
  });
  return new TransactionBuilder(new Account(owner, "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(30)
    .build()
    .toEnvelope()
    .toXdr("base64");
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

  fireEvent.click(screen.getByRole("tab", { name: /secret key/i }));
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

  fireEvent.click(screen.getByRole("tab", { name: /secret key/i }));
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

  fireEvent.click(screen.getByRole("tab", { name: /secret key/i }));
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

test("RevokeAllowanceModal › an unresolved hash for the owner stops the revoke before anything is built", async () => {
  stubWalletKit();
  spyOn(recovery, "findUnresolved").mockImplementation(async () => ({ id: "s" }) as never);
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    return new Response("{}", { status: 200 });
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

  fireEvent.click(screen.getByRole("tab", { name: /secret key/i }));
  fireEvent.change(screen.getByPlaceholderText("S..."), {
    target: { value: OWNER_KP.secret() },
  });
  fireEvent.click(screen.getByRole("button", { name: /revoke allowance/i }));

  await waitFor(() => expect(screen.getByText(/choose Check again/i)).toBeTruthy());
  expect(fetched).toBe(0);
  expect(onRevoked).not.toHaveBeenCalled();
});

function renderSecretKeyModal(onClose: () => void, onRevoked: () => void = () => {}): void {
  render(
    <RevokeAllowanceModal
      network="testnet"
      owner={OWNER}
      allowance={allowance()}
      onClose={onClose}
      onRevoked={onRevoked}
    />
  );
  fireEvent.click(screen.getByRole("tab", { name: /secret key/i }));
  fireEvent.change(screen.getByPlaceholderText("S..."), {
    target: { value: OWNER_KP.secret() },
  });
}

function renderModal(): void {
  render(
    <RevokeAllowanceModal
      network="testnet"
      owner={OWNER}
      allowance={allowance()}
      onClose={() => {}}
      onRevoked={() => {}}
    />
  );
}

function confirmButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /revoke allowance/i }) as HTMLButtonElement;
}

test("RevokeAllowanceModal › arrow keys switch the signer inside the dialog, and only they do", () => {
  stubWalletKit();
  renderModal();
  const wallet = screen.getByRole("tab", { name: /wallet/i });
  const secret = screen.getByRole("tab", { name: /secret key/i });
  wallet.focus();

  fireEvent.keyDown(wallet, { key: "ArrowRight" });
  expect(secret.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(secret);
  expect(screen.getByPlaceholderText("S...")).toBeTruthy();

  fireEvent.keyDown(secret, { key: "Home" });
  expect(wallet.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(wallet);
  expect(screen.queryByPlaceholderText("S...")).toBeNull();
});

test("RevokeAllowanceModal › Escape on a tab still reaches the dialog", () => {
  stubWalletKit();
  const onClose = mock(() => {});
  render(
    <RevokeAllowanceModal
      network="testnet"
      owner={OWNER}
      allowance={allowance()}
      onClose={onClose}
      onRevoked={() => {}}
    />
  );
  const wallet = screen.getByRole("tab", { name: /wallet/i });
  wallet.focus();
  fireEvent.keyDown(wallet, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("RevokeAllowanceModal › both tabs are disabled while signing", async () => {
  stubWalletKit();
  spyOn(recovery, "findUnresolved").mockResolvedValue(undefined as never);
  holdFetch();
  renderSecretKeyModal(() => {});

  await act(async () => {
    fireEvent.click(confirmButton());
  });

  const tabs = screen.getAllByRole("tab") as HTMLButtonElement[];
  expect(tabs.map((el) => el.disabled)).toEqual([true, true]);
  expect(tabs.map((el) => el.getAttribute("tabindex"))).toEqual(["-1", "-1"]);
  expect(tabs[1].getAttribute("aria-selected")).toBe("true");
  fireEvent.click(tabs[0]);
  fireEvent.keyDown(tabs[1], { key: "ArrowLeft" });
  expect(tabs[1].getAttribute("aria-selected")).toBe("true");
});

test("RevokeAllowanceModal › the tablist goes inert with the dialog while the wallet connects", () => {
  spyOn(walletKit, "useWalletKitConnection").mockImplementation(
    () =>
      ({
        address: null,
        connecting: true,
        error: null,
        networkMismatch: false,
        connect: async () => {},
        disconnect: async () => {},
      }) as unknown as ReturnType<typeof walletKit.useWalletKitConnection>
  );
  renderModal();
  const dialog = document.querySelector("dialog") as HTMLDialogElement;
  expect(dialog.hasAttribute("inert")).toBe(true);
  expect(dialog.contains(document.querySelector("[role='tablist']"))).toBe(true);
  expect(document.activeElement).not.toBe(screen.getAllByRole("tab", { hidden: true })[0]);
});

test("RevokeAllowanceModal › reselecting the secret key tab keeps the field, the key and confirm", () => {
  stubWalletKit();
  renderSecretKeyModal(() => {});
  const input = screen.getByPlaceholderText("S...") as HTMLInputElement;
  expect(confirmButton().disabled).toBe(false);

  fireEvent.click(screen.getByRole("tab", { name: /secret key/i }));

  expect(screen.getByPlaceholderText("S...")).toBe(input);
  expect(input.value).toBe(OWNER_KP.secret());
  expect(confirmButton().disabled).toBe(false);
});

test("RevokeAllowanceModal › the tabs write no key to the markup or storage", () => {
  stubWalletKit();
  renderSecretKeyModal(() => {});
  const secret = OWNER_KP.secret();
  const secretTab = screen.getByRole("tab", { name: /secret key/i });

  fireEvent.keyDown(secretTab, { key: "ArrowLeft" });
  fireEvent.keyDown(screen.getByRole("tab", { name: /wallet/i }), { key: "ArrowRight" });

  expect(document.documentElement.outerHTML).not.toContain(secret);
  expect((screen.getByPlaceholderText("S...") as HTMLInputElement).value).toBe("");
  expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toContain(secret);
});

test("RevokeAllowanceModal › leaving the key tab forgets the key, so coming back cannot revoke", async () => {
  stubWalletKit();
  spyOn(recovery, "findUnresolved").mockResolvedValue(undefined as never);
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  renderSecretKeyModal(() => {});
  expect(confirmButton().disabled).toBe(false);

  fireEvent.click(screen.getByRole("tab", { name: /wallet/i }));
  fireEvent.click(screen.getByRole("tab", { name: /secret key/i }));

  expect((screen.getByPlaceholderText("S...") as HTMLInputElement).value).toBe("");
  expect(confirmButton().disabled).toBe(true);
  await act(async () => {
    fireEvent.click(confirmButton());
  });
  expect(fetched).toBe(0);
  expect(screen.queryByRole("button", { name: /revoking/i })).toBeNull();
});

test("RevokeAllowanceModal › Tab stays inside with the key panel open and confirm disabled", () => {
  stubWalletKit();
  renderModal();
  const secret = screen.getByRole("tab", { name: /secret key/i });
  fireEvent.click(secret);
  const reveal = screen.getByRole("button", { name: "Show secret key" });
  const close = screen.getByRole("button", { name: "Close" });
  expect(confirmButton().disabled).toBe(true);

  reveal.focus();
  fireEvent.keyDown(reveal, { key: "Tab" });
  expect(document.activeElement).toBe(close);

  fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(reveal);
});

function pressEscape(): void {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
}

function clickScrim(): void {
  fireEvent.click(document.querySelector("[data-dialog-scrim]") as Element);
}

function holdFetch(): (response: Response) => void {
  let release: (response: Response) => void = () => {};
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => {
      release = resolve;
    })) as unknown as typeof fetch;
  return (response) => release(response);
}

test("RevokeAllowanceModal › while a revoke is in flight nothing closes it, and a failure can", async () => {
  stubWalletKit();
  const release = holdFetch();
  const onClose = mock(() => {});
  renderSecretKeyModal(onClose);

  fireEvent.click(screen.getByRole("button", { name: /revoke allowance/i }));
  await waitFor(() => expect(screen.getByRole("button", { name: /revoking/i })).toBeTruthy());

  pressEscape();
  fireEvent.keyDown(document.body, { key: "Escape" });
  clickScrim();
  expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  expect(onClose).not.toHaveBeenCalled();

  release(new Response(JSON.stringify({ message: "nope" }), { status: 500 }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Close" })).toBeTruthy());
  pressEscape();
  expect(onClose).toHaveBeenCalledTimes(1);
  clickScrim();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledTimes(3);
});

test("RevokeAllowanceModal › the result step closes with Done", async () => {
  stubWalletKit();
  mockFetchSequence([
    { status: 200, body: { transaction: realRevokeXdr() } },
    { status: 200, body: { hash: "abc123", ledger: 42 } },
  ]);
  const onClose = mock(() => {});
  renderSecretKeyModal(onClose);
  fireEvent.click(screen.getByRole("button", { name: /revoke allowance/i }));

  await waitFor(() => expect(screen.getByRole("button", { name: "Done" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("RevokeAllowanceModal › while the wallet picker is open the dialog hands over the keyboard", () => {
  spyOn(walletKit, "useWalletKitConnection").mockImplementation(
    () =>
      ({
        address: null,
        connecting: true,
        error: null,
        networkMismatch: false,
        connect: async () => {},
        disconnect: async () => {},
      }) as unknown as ReturnType<typeof walletKit.useWalletKitConnection>
  );
  const onClose = mock(() => {});
  render(
    <RevokeAllowanceModal
      network="testnet"
      owner={OWNER}
      allowance={allowance()}
      onClose={onClose}
      onRevoked={() => {}}
    />
  );
  const dialog = screen.getByRole("dialog", { hidden: true });
  expect(dialog.hasAttribute("inert")).toBe(true);
  const close = dialog.querySelector('button[aria-label="Close"]') as HTMLElement;
  expect(close.closest("[inert]")).toBe(dialog);
  expect(fireEvent.keyDown(document.body, { key: "Tab" })).toBe(true);
  expect(dialog.contains(document.activeElement) && document.activeElement !== dialog).toBe(false);
  fireEvent.keyDown(document.body, { key: "Escape" });
  clickScrim();
  expect(onClose).not.toHaveBeenCalled();
});

test("RevokeAllowanceModal › Escape closes it when idle", () => {
  stubWalletKit();
  const onClose = mock(() => {});
  renderSecretKeyModal(onClose);
  pressEscape();
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("RevokeAllowanceModal › the key is not in the markup and a new mount starts empty", () => {
  stubWalletKit();
  const { unmount } = render(
    <RevokeAllowanceModal
      network="testnet"
      owner={OWNER}
      allowance={allowance()}
      onClose={() => {}}
      onRevoked={() => {}}
    />
  );
  fireEvent.click(screen.getByRole("tab", { name: /secret key/i }));
  fireEvent.change(screen.getByPlaceholderText("S..."), {
    target: { value: OWNER_KP.secret() },
  });
  expect(document.documentElement.outerHTML).not.toContain(OWNER_KP.secret());

  unmount();
  expect(document.querySelector("dialog")).toBeNull();

  render(
    <RevokeAllowanceModal
      network="testnet"
      owner={OWNER}
      allowance={allowance()}
      onClose={() => {}}
      onRevoked={() => {}}
    />
  );
  fireEvent.click(screen.getByRole("tab", { name: /secret key/i }));
  expect((screen.getByPlaceholderText("S...") as HTMLInputElement).value).toBe("");
  expect(
    (screen.getByRole("button", { name: /revoke allowance/i }) as HTMLButtonElement).disabled
  ).toBe(true);
});
