/**
 * A transaction the network rejected (RPC status ERROR) or that failed after
 * inclusion (status FAILED). `resultCode` carries the decoded tx/op code so
 * callers can branch on it.
 */
export class TxSubmitError extends Error {
  readonly resultCode: string | null;
  constructor(message: string, resultCode: string | null) {
    super(message);
    this.name = "TxSubmitError";
    this.resultCode = resultCode;
  }
}

export class AccountNotFoundError extends Error {
  constructor(address: string) {
    super(`Account ${address} does not exist on this network.`);
    this.name = "AccountNotFoundError";
  }
}

export class TxTimeoutError extends Error {
  constructor() {
    super("Transaction confirmation timed out. It is safe to retry.");
    this.name = "TxTimeoutError";
  }
}

export class NoConversionPathError extends Error {
  constructor(asset: string) {
    super(
      `No conversion path found for ${asset}. You may need to send the balance back to the issuer.`
    );
    this.name = "NoConversionPathError";
  }
}

export class FastPathUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "FastPathUnavailableError";
  }
}

export class AssetRouteLostError extends Error {
  constructor(
    public readonly asset: string,
    public readonly assetCode: string
  ) {
    super(
      `The swap route for ${assetCode} is no longer available. Return it to the issuer to continue.`
    );
    this.name = "AssetRouteLostError";
  }
}
