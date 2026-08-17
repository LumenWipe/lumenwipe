import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";

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
    const built = TransactionBuilder.fromXDR(xdr, networkPassphrase);
    built.sign(this.keypair);
    return built.toEnvelope().toXDR("base64");
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
    private readonly preimage: Buffer
  ) {}

  async sign(xdr: string, networkPassphrase: string): Promise<string> {
    const built = TransactionBuilder.fromXDR(xdr, networkPassphrase);
    built.signHashX(this.preimage);
    return built.toEnvelope().toXDR("base64");
  }
}

/**
 * Signs by delegating to a wallet-kit-shaped signing function, injected rather
 * than imported directly - keeps this class free of any DOM/browser-extension
 * dependency and independently testable. Construct with
 * `StellarWalletsKit.signTransaction` in real usage.
 */
export class WalletKitSigner implements TransactionSigner {
  constructor(
    public readonly publicKey: string,
    private readonly signWithKit: (
      xdr: string,
      opts: { networkPassphrase: string; address: string }
    ) => Promise<{ signedTxXdr: string }>
  ) {}

  async sign(xdr: string, networkPassphrase: string): Promise<string> {
    const { signedTxXdr } = await this.signWithKit(xdr, {
      networkPassphrase,
      address: this.publicKey,
    });
    return signedTxXdr;
  }
}
