import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { VARIAL_ID } from "@creit-tech/stellar-wallets-kit/modules/varial";
import { XBULL_ID } from "@creit-tech/stellar-wallets-kit/modules/xbull";
import { ALBEDO_ID } from "@creit-tech/stellar-wallets-kit/modules/albedo";
import { RABET_ID } from "@creit-tech/stellar-wallets-kit/modules/rabet";
import { HANA_ID } from "@creit-tech/stellar-wallets-kit/modules/hana";
import { WALLET_CONNECT_ID } from "@creit-tech/stellar-wallets-kit/modules/wallet-connect";

/** Whether a wallet can sign a SEP-53 message: "depends" for WalletConnect, which forwards the
 *  request to whichever phone wallet is paired. */
export type MessageSigningSupport = "yes" | "depends" | "no";

const SUPPORT: Readonly<Record<string, MessageSigningSupport>> = {
  [VARIAL_ID]: "yes",
  [XBULL_ID]: "yes",
  [HANA_ID]: "yes",
  [WALLET_CONNECT_ID]: "depends",
  [ALBEDO_ID]: "no",
  [RABET_ID]: "no",
};

const NAMES: Readonly<Record<string, string>> = {
  [VARIAL_ID]: "Varial",
  [XBULL_ID]: "xBull",
  [HANA_ID]: "Hana",
  [WALLET_CONNECT_ID]: "WalletConnect",
  [ALBEDO_ID]: "Albedo",
  [RABET_ID]: "Rabet",
};

export function messageSigningSupport(walletId: string | null): MessageSigningSupport {
  return (walletId && SUPPORT[walletId]) || "no";
}

export function walletName(walletId: string | null): string {
  return (walletId && NAMES[walletId]) || "This wallet";
}

/** Wallets that can sign in, by name, for the explanation shown after picking one that cannot. */
export const MESSAGE_SIGNING_WALLETS = ["Varial (formerly Freighter)", "xBull", "Hana"] as const;

export function isContractAddress(address: string): boolean {
  return StrKey.isValidContract(address);
}

export type WalletSignInFailure =
  /** A contract (C...) account: it has no single key to sign a message with. */
  | "contract_account"
  /** The wallet cannot sign a message at all. */
  | "unsupported_wallet"
  /** The wallet answered for another account than the one it connected. */
  | "signer_mismatch"
  /** The signature does not verify for the connected account. */
  | "bad_signature";

export class WalletSignInError extends Error {
  constructor(
    readonly reason: WalletSignInFailure,
    readonly walletId: string | null = null
  ) {
    super(reason);
    this.name = "WalletSignInError";
  }
}

const HEX = /^[0-9a-f]{128}$/i;
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

function bytesFromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesFromBase64(value: string): Uint8Array | null {
  if (!BASE64.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * The 64-byte ed25519 signature a wallet returned, as standard base64 for the API. Wallets answer
 * in base64 or hex; anything else, or any other length, is null.
 */
export function normalizeSignature(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  const bytes = HEX.test(value) ? bytesFromHex(value) : bytesFromBase64(value);
  return bytes && bytes.length === 64 ? toBase64(bytes) : null;
}

/** True only if `signature` (base64) is `address` signing `message` under SEP-53. */
export function verifySignedMessage(address: string, message: string, signature: string): boolean {
  const bytes = bytesFromBase64(signature);
  if (!bytes || !StrKey.isValidEd25519PublicKey(address)) return false;
  try {
    return Keypair.fromPublicKey(address).verifyMessage(message, bytes);
  } catch {
    return false;
  }
}

/** The part of the wallet kit sign-in uses. */
export interface MessageSigner {
  signMessage(
    message: string,
    opts?: { address?: string; networkPassphrase?: string }
  ): Promise<{ signedMessage: string; signerAddress?: string }>;
}

/**
 * Asks the connected wallet to sign the challenge and checks the answer before it leaves the
 * browser: a wallet that signed for another account, or a signature that does not verify for
 * `address`, is refused here instead of costing a round trip and a vague 401.
 */
export async function signChallenge(
  signer: MessageSigner,
  walletId: string | null,
  address: string,
  message: string,
  networkPassphrase?: string
): Promise<string> {
  if (isContractAddress(address)) throw new WalletSignInError("contract_account", walletId);
  if (messageSigningSupport(walletId) === "no") {
    throw new WalletSignInError("unsupported_wallet", walletId);
  }
  const { signedMessage, signerAddress } = await signer.signMessage(message, {
    address,
    ...(networkPassphrase ? { networkPassphrase } : {}),
  });
  if (signerAddress && signerAddress !== address) {
    throw new WalletSignInError("signer_mismatch", walletId);
  }
  const signature = normalizeSignature(signedMessage);
  if (!signature || !verifySignedMessage(address, message, signature)) {
    throw new WalletSignInError("bad_signature", walletId);
  }
  return signature;
}

/** How long the wallet's network is waited on before signing on the kit's own. */
export const NETWORK_LOOKUP_TIMEOUT_MS = 4_000;

/**
 * The network the wallet itself reports, so a wallet that checks the passphrase it is asked to
 * sign on is asked on its own. Undefined when it cannot say (most wallets but Freighter) or does
 * not answer in time; the kit then uses its own network.
 */
export async function walletNetworkPassphrase(
  wallet: { getNetwork(): Promise<{ networkPassphrase?: string }> },
  timeoutMs = NETWORK_LOOKUP_TIMEOUT_MS
): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    const answer = wallet.getNetwork().then(
      ({ networkPassphrase }) => networkPassphrase || undefined,
      () => undefined
    );
    return await Promise.race([answer, timeout]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
