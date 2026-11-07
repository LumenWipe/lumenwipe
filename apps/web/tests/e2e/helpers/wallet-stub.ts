import { expect, type Page } from "@playwright/test";
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";

/**
 * Stands in for the Freighter extension at the one seam the real one uses: window.postMessage.
 * The wallet kit and @stellar/freighter-api run unmodified; only the extension's answers are
 * scripted, per test.
 *
 * The page side only relays. Each request goes to a function exposed from the test process,
 * which decides the answer from the current options, so:
 * - a signature comes from a Keypair held here, and no secret ever enters the page;
 * - `set()` changes the wallet mid-test, and the change survives navigations;
 * - every request is recorded, so a test can wait for a signing request instead of guessing
 *   from copy.
 *
 * Test-only: nothing under apps/web outside tests/ imports this file.
 */

/** The error shape freighter-api reads from the extension's `apiError`. */
export interface WalletApiError {
  code: number;
  message: string;
}

export type WalletSignBehavior =
  /** Signs the requested transaction with `keypair`. A keypair other than the reported address is
   *  a wallet signing with a different account. `signerAddress` defaults to the keypair's. */
  | { kind: "approve"; keypair: Keypair; signerAddress?: string; delayMs?: number }
  /** Refuses with a wallet error. Defaults to Freighter's user rejection, code -4. */
  | { kind: "reject"; code?: number; message?: string; delayMs?: number }
  /** Never answers, as a wallet whose popup is left open. */
  | { kind: "never" };

export interface WalletStubOptions {
  /** The account the wallet reports as connected. */
  address: string;
  /** The network the wallet reports, or the error it answers a network request with. */
  network?: "TESTNET" | "PUBLIC" | { error: WalletApiError };
  /** How the wallet answers a signing request. Defaults to a user rejection. */
  sign?: WalletSignBehavior;
}

/** A request the page made to the wallet, as the extension received it. */
export interface WalletRequest {
  type: string;
  transactionXdr?: string;
  networkPassphrase?: string;
  accountToSign?: string;
}

export interface WalletStub {
  /** Every request the page made so far, in order. */
  readonly requests: readonly WalletRequest[];
  /** The signing requests among them. */
  readonly signRequests: readonly WalletRequest[];
  /** Replaces the given options from now on. Requests already waiting are not answered again. */
  set(options: Partial<WalletStubOptions>): void;
  /** Resolves with the next signing request, or the latest one if one was already made. */
  waitForSignRequest(timeoutMs?: number): Promise<WalletRequest>;
}

export const USER_REJECTED: WalletApiError = {
  code: -4,
  message: "The user rejected this request.",
};

const NETWORKS = {
  TESTNET: {
    network: "TESTNET",
    networkUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: Networks.TESTNET,
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
  },
  PUBLIC: {
    network: "PUBLIC",
    networkUrl: "https://horizon.stellar.org",
    networkPassphrase: Networks.PUBLIC,
    sorobanRpcUrl: "https://mainnet.sorobanrpc.com",
  },
} as const;

const BINDING = "__lumenwipeWalletStubAnswer";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Installs the stub before any page script runs. Call it before the first navigation.
 */
export async function installWalletStub(
  page: Page,
  initial: WalletStubOptions
): Promise<WalletStub> {
  let options: WalletStubOptions = { ...initial };
  const requests: WalletRequest[] = [];
  const signWaiters: Array<(request: WalletRequest) => void> = [];

  async function answer(request: WalletRequest): Promise<Record<string, unknown> | null> {
    const network = options.network ?? "TESTNET";
    switch (request.type) {
      case "REQUEST_CONNECTION_STATUS":
        return { isConnected: true };
      case "REQUEST_ALLOWED_STATUS":
      case "SET_ALLOWED_STATUS":
        return { isAllowed: true };
      case "REQUEST_ACCESS":
      case "REQUEST_PUBLIC_KEY":
        return { publicKey: options.address };
      case "REQUEST_NETWORK_DETAILS":
        return typeof network === "string"
          ? { networkDetails: NETWORKS[network] }
          : { networkDetails: { network: "", networkPassphrase: "" }, apiError: network.error };
      case "REQUEST_NETWORK":
        return typeof network === "string"
          ? { network, networkPassphrase: NETWORKS[network].networkPassphrase }
          : { apiError: network.error };
      case "SUBMIT_TRANSACTION":
        return answerSign(request);
      default:
        return {};
    }
  }

  async function answerSign(request: WalletRequest): Promise<Record<string, unknown> | null> {
    const behavior = options.sign ?? { kind: "reject" };
    if (behavior.kind === "never") return null;
    if (behavior.delayMs) await sleep(behavior.delayMs);
    if (behavior.kind === "reject") {
      return {
        signedTransaction: "",
        apiError: {
          code: behavior.code ?? USER_REJECTED.code,
          message: behavior.message ?? USER_REJECTED.message,
        },
      };
    }
    const passphrase = request.networkPassphrase ?? Networks.TESTNET;
    const tx = TransactionBuilder.fromXdr(request.transactionXdr ?? "", passphrase);
    tx.sign(behavior.keypair);
    return {
      signedTransaction: tx.toEnvelope().toXdr("base64"),
      signerAddress: behavior.signerAddress ?? behavior.keypair.publicKey(),
    };
  }

  await page.exposeFunction(BINDING, async (request: WalletRequest) => {
    requests.push(request);
    if (request.type === "SUBMIT_TRANSACTION") signWaiters.splice(0).forEach((w) => w(request));
    return answer(request);
  });

  await page.addInitScript((binding) => {
    const relay = (window as unknown as Record<string, (r: unknown) => Promise<unknown>>)[binding];
    window.addEventListener("message", (event) => {
      const data = event.data as {
        source?: string;
        messageId?: number;
        type?: string;
        transactionXdr?: string;
        networkPassphrase?: string;
        accountToSign?: string;
      } | null;
      if (event.source !== window || data?.source !== "FREIGHTER_EXTERNAL_MSG_REQUEST") return;
      void relay({
        type: data.type ?? "",
        transactionXdr: data.transactionXdr,
        networkPassphrase: data.networkPassphrase,
        accountToSign: data.accountToSign,
      }).then((reply) => {
        if (reply === null) return;
        window.postMessage(
          // freighter-api matches replies on `messagedId`, spelled as the extension spells it.
          { source: "FREIGHTER_EXTERNAL_MSG_RESPONSE", messagedId: data.messageId, ...reply },
          window.location.origin
        );
      });
    });
  }, BINDING);

  return {
    get requests() {
      return requests;
    },
    get signRequests() {
      return requests.filter((r) => r.type === "SUBMIT_TRANSACTION");
    },
    set(next) {
      options = { ...options, ...next };
    },
    waitForSignRequest(timeoutMs = 30_000) {
      const seen = requests.filter((r) => r.type === "SUBMIT_TRANSACTION").at(-1);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no signing request within ${timeoutMs}ms`)),
          timeoutMs
        );
        signWaiters.push((request) => {
          clearTimeout(timer);
          resolve(request);
        });
      });
    },
  };
}

/** Connects the stubbed wallet from the signing panel: the kit lists Freighter as "Varial". */
export async function connectStubWallet(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: /Connect wallet/i })
    .last()
    .click();
  await page.getByText("Varial", { exact: true }).click();
  await expect(page.getByText(/Connected:/)).toBeVisible({ timeout: 30_000 });
}
