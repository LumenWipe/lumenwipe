import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import type { Network } from "@/config/networks";
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
    // Surrounding whitespace from a paste is not part of the key.
    this.keypair = Keypair.fromSecret(secretKey.trim());
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

/**
 * The screen dropped the signer a run was started with (Forget key, another tab, leaving the
 * screen). Thrown before the next signature, so the run asks nothing more of that signer.
 */
export class SignerReleasedError extends Error {
  constructor() {
    super("The signer this run started with was cleared.");
    this.name = "SignerReleasedError";
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

/**
 * The wallet reported that it signed with an account other than the one it was asked to sign
 * with. Thrown before the signed transaction is returned, so nothing it signed is used. A pre-check
 * only: a wallet that reports nothing is still held to the approved-hash, own-signature and weight
 * checks after signing, which stay the authority. The own-signature check throws this error too,
 * naming the account key whose signature the wallet added instead.
 */
export class WalletSignerMismatchError extends Error {
  constructor(
    readonly walletId: string | null,
    readonly expected: string,
    readonly reported: string
  ) {
    super(`The wallet signed with ${reported} instead of ${expected}.`);
    this.name = "WalletSignerMismatchError";
  }
}

/**
 * The wallet signed the transaction for another network: its signature from the expected key
 * does not verify for the network it was asked to sign for, and does verify for `signedFor`.
 * Thrown before the signed transaction is returned.
 */
export class WalletWrongNetworkError extends Error {
  constructor(
    readonly walletId: string | null,
    readonly requested: string,
    readonly signedFor: string
  ) {
    super(`The wallet signed for "${signedFor}" instead of "${requested}".`);
    this.name = "WalletWrongNetworkError";
  }
}

/** Why a wallet session can no longer sign: it changed or went stale, it is on another network,
 *  or its unknown network is no longer confirmed. */
export type WalletUnusableReason = "session" | "network" | "network-unconfirmed";

/**
 * The wallet session stopped being usable while a run was in progress, found right before a
 * signature. Thrown before the wallet is asked, so nothing is signed or sent.
 */
export class WalletNotUsableError extends Error {
  constructor(
    readonly reason: WalletUnusableReason,
    readonly network: Network
  ) {
    super(`The wallet session is not usable: ${reason}.`);
    this.name = "WalletNotUsableError";
  }
}

/** The networks a wallet could have signed for instead of the one asked for. */
const KNOWN_PASSPHRASES: readonly string[] = [Networks.PUBLIC, Networks.TESTNET];

/**
 * The network `signedXdr` was signed for by `publicKey`, when that is a network other than
 * `requested`; null otherwise. A signature that verifies for `requested` always wins, so a valid
 * signature is never refused. An envelope that cannot be read is left to the checks after signing.
 */
export function otherNetworkSignedFor(
  signedXdr: string,
  requested: string,
  publicKey: string
): string | null {
  let keypair: Keypair;
  let signatures: Uint8Array[];
  try {
    keypair = Keypair.fromPublicKey(publicKey);
    const hint = keypair.signatureHint();
    signatures = TransactionBuilder.fromXdr(signedXdr, requested)
      .signatures.filter((s) => {
        const bytes = s.hint.toBytes();
        return bytes.length === hint.length && bytes.every((byte, i) => byte === hint[i]);
      })
      .map((s) => s.signature.toBytes());
  } catch {
    return null;
  }
  if (signatures.length === 0) return null;
  const verifiesFor = (passphrase: string): boolean => {
    const hash = TransactionBuilder.fromXdr(signedXdr, passphrase).hash();
    return signatures.some((signature) => keypair.verify(hash, signature));
  };
  if (verifiesFor(requested)) return null;
  // `requested` already failed above, so only another network can match here.
  return KNOWN_PASSPHRASES.find(verifiesFor) ?? null;
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
  private lastMismatch: string | null = null;
  private readonly startTimeout: (ms: number) => SignTimer;
  private readonly now: () => number;

  constructor(
    public readonly publicKey: string,
    private readonly signWithKit: (
      xdr: string,
      opts: { networkPassphrase: string; address: string }
    ) => Promise<{ signedTxXdr: string; signerAddress?: string }>,
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

  /** The account the wallet last reported signing with, when it was not this signer's. */
  mismatchedAccount(): string | null {
    return this.lastMismatch;
  }

  async sign(xdr: string, networkPassphrase: string): Promise<string> {
    const timeoutMs = signTimeoutMs(submissionValidUntil(xdr, networkPassphrase), this.now());
    const timer = this.startTimeout(timeoutMs);
    // Through a then(), so a kit that throws before returning a promise is typed the same way.
    const answer = Promise.resolve()
      .then(() => this.signWithKit(xdr, { networkPassphrase, address: this.publicKey }))
      .then(
        ({ signedTxXdr, signerAddress }) => {
          // Pre-checks, so a wallet on another account or network is named in plain words. They
          // only ever refuse; what passes is still held to the checks after signing.
          if (signerAddress && signerAddress !== this.publicKey) {
            throw new WalletSignerMismatchError(this.walletId, this.publicKey, signerAddress);
          }
          const signedFor = otherNetworkSignedFor(signedTxXdr, networkPassphrase, this.publicKey);
          if (signedFor) {
            throw new WalletWrongNetworkError(this.walletId, networkPassphrase, signedFor);
          }
          return signedTxXdr;
        },
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
      const signed = await Promise.race([answer, expired]);
      this.lastMismatch = null;
      return signed;
    } catch (err) {
      this.lastMismatch = err instanceof WalletSignerMismatchError ? err.reported : null;
      throw err;
    } finally {
      timer.cancel();
    }
  }
}
