import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { submissionValidUntil } from "@/lib/stellar/submission";
import { signTimeoutMs, startSignTimeout, type SignTimer } from "@/lib/stellar/wallet-timeout";

/**
 * Abstracts "how a transaction gets signed" so useCloseExecution can drive the
 * close loop the same way regardless of whether the user is signing with a
 * pasted secret key or a connected wallet. Implementations must never persist
 * key material beyond their own lifetime - the caller owns disposal.
 */
export interface TransactionSigner {
  publicKey: string;
  sign(xdr: string, networkPassphrase: string): Promise<string>;
}

/** Signs with an in-memory keypair derived from a pasted secret key. */
export class SecretKeySigner implements TransactionSigner {
  private readonly keypair: Keypair;

  constructor(secretKey: string) {
    this.keypair = Keypair.fromSecret(secretKey);
  }

  get publicKey(): string {
    return this.keypair.publicKey();
  }

  async sign(xdr: string, networkPassphrase: string): Promise<string> {
    const built = TransactionBuilder.fromXdr(xdr, networkPassphrase);
    built.sign(this.keypair);
    return built.toEnvelope().toXdr("base64");
  }
}

/**
 * Satisfies a hash(x) signer by appending a decorated signature whose bytes are the
 * preimage itself (`Transaction.signHashX`), not an ed25519 signature - a hash(x) signer's
 * key IS sha256(preimage), so there is no keypair to sign with. `publicKey` is the signer's
 * "X..." strkey, matching the shape `accountState.signers` already uses so the engine's
 * known-signer check (useCloseExecution.ts) works unmodified. The caller must only ever
 * construct this with a preimage already validated by `verifyHashXPreimage` - this class
 * does not re-validate.
 */
export class HashXPreimageSigner implements TransactionSigner {
  constructor(
    public readonly publicKey: string,
    private readonly preimage: Uint8Array
  ) {}

  async sign(xdr: string, networkPassphrase: string): Promise<string> {
    const built = TransactionBuilder.fromXdr(xdr, networkPassphrase);
    built.signHashX(this.preimage);
    return built.toEnvelope().toXdr("base64");
  }
}

/** The wallet kit's id for WalletConnect, whose wallet answers from another device. */
export const WALLET_CONNECT_WALLET_ID = "wallet_connect";

/**
 * A wallet refused or failed to sign. Thrown only by `WalletKitSigner`, so a timeout, a network
 * failure or anything else outside the wallet is never read as one. `code` is the wallet kit's,
 * which normalizes every wallet's error to it: -1 internal, -2 external, -3 unsupported or
 * domain-specific, -4 rejected by the user. The wallet's own text is kept as the message for
 * debugging and is never shown.
 */
export class WalletSigningError extends Error {
  constructor(
    readonly code: number,
    readonly walletId: string | null,
    walletMessage: string
  ) {
    super(walletMessage);
    this.name = "WalletSigningError";
  }
}

/** The wallet did not answer within the time it was given. Its prompt may still be open, and
 *  whatever it answers later is dropped. */
export class WalletSigningTimeoutError extends Error {
  constructor(
    readonly walletId: string | null,
    readonly timeoutMs: number
  ) {
    super(`The wallet did not answer within ${timeoutMs} ms.`);
    this.name = "WalletSigningTimeoutError";
  }
}

/** The kit's own reading of a wallet error (`parseError` in the kit): a nested `error.code`, then
 *  `code`, else -1. */
function walletErrorOf(thrown: unknown, walletId: string | null): WalletSigningError {
  const outer = typeof thrown === "object" && thrown !== null ? thrown : {};
  const inner = (outer as { error?: unknown }).error;
  const source = typeof inner === "object" && inner !== null ? inner : outer;
  const code = (source as { code?: unknown }).code;
  const message = (source as { message?: unknown }).message;
  return new WalletSigningError(
    typeof code === "number" && Number.isFinite(code) && code !== 0 ? code : -1,
    walletId,
    typeof message === "string" ? message : typeof thrown === "string" ? thrown : ""
  );
}

export interface WalletKitSignerOptions {
  /** The kit's id of the wallet in use, e.g. `freighter` or `wallet_connect`. */
  walletId?: string | null;
  /** Starts the signing timeout. Injected in tests. */
  startTimeout?: (ms: number) => SignTimer;
  /** The clock the validity window is read against. Injected in tests. */
  now?: () => number;
}

/**
 * Signs by delegating to a wallet-kit-shaped signing function, injected rather
 * than imported directly - keeps this class free of any DOM/browser-extension
 * dependency and independently testable. Construct with
 * `StellarWalletsKit.signTransaction` in real usage.
 *
 * Every failure is thrown typed (`WalletSigningError` with the kit's code), and the wallet is
 * waited on for at most `signTimeoutMs` of the transaction: a prompt that never answers ends in
 * `WalletSigningTimeoutError`, and an answer arriving after that is dropped, never returned to
 * this or a later attempt. Only signing is timed: nothing here sends anything. The wallet is
 * always asked, whatever this device's clock says about the validity window.
 */
export class WalletKitSigner implements TransactionSigner {
  readonly walletId: string | null;
  private openPrompt: Promise<void> | null = null;
  private readonly startTimeout: (ms: number) => SignTimer;
  private readonly now: () => number;

  constructor(
    public readonly publicKey: string,
    private readonly signWithKit: (
      xdr: string,
      opts: { networkPassphrase: string; address: string }
    ) => Promise<{ signedTxXdr: string }>,
    options: WalletKitSignerOptions = {}
  ) {
    this.walletId = options.walletId ?? null;
    this.startTimeout = options.startTimeout ?? startSignTimeout;
    this.now = options.now ?? Date.now;
  }

  /**
   * A prompt this signer gave up on that the wallet has not answered yet, settling when it does;
   * null when there is none. The kit cannot close a prompt, so asking again while this is open
   * can stack a second one on top of it.
   */
  stalePrompt(): Promise<void> | null {
    return this.openPrompt;
  }

  async sign(xdr: string, networkPassphrase: string): Promise<string> {
    const timeoutMs = signTimeoutMs(submissionValidUntil(xdr, networkPassphrase), this.now());
    const timer = this.startTimeout(timeoutMs);
    // Through a then(), so a kit that throws before returning a promise is typed the same way.
    const answer = Promise.resolve()
      .then(() => this.signWithKit(xdr, { networkPassphrase, address: this.publicKey }))
      .then(
        ({ signedTxXdr }) => signedTxXdr,
        (thrown: unknown) => {
          throw walletErrorOf(thrown, this.walletId);
        }
      );
    // A late failure, after the timeout won, has nobody left to hear it.
    answer.catch(() => {});
    const expired = timer.expired.then((): never => {
      // The kit has no way to close its prompt, so it stays open; remember it until it answers.
      const settled = answer.then(
        () => {},
        () => {}
      );
      this.openPrompt = settled;
      void settled.then(() => {
        if (this.openPrompt === settled) this.openPrompt = null;
      });
      throw new WalletSigningTimeoutError(this.walletId, timeoutMs);
    });
    try {
      return await Promise.race([answer, expired]);
    } finally {
      timer.cancel();
    }
  }
}
