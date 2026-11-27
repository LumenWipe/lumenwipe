import { randomBytes } from "crypto";
import { Logger } from "@nestjs/common";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  authorizeEntry,
  rpc,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASES, type Network } from "@/config/networks";
import { instanceOfEntry } from "@/lib/stellar/contract-data";
import { codeRefOf } from "@/lib/stellar/contract-instance";
import { keypairFromEnv } from "@/lib/stellar/secret-keypair";
import { hmac, safeEqual } from "./wallet-auth";

/**
 * Contract-account (C...) sign-in, after SEP-45 v0.1.1: the challenge is a pair of authorization
 * entries for `web_auth_verify` on the web authentication contract, one for the account and one
 * signed by the server's own account, and a signed challenge is accepted only when an enforcing
 * simulation of that call succeeds on every configured RPC provider. The account's own
 * `__check_auth` decides whether the signature is good; the host never lets anyone call it directly.
 */

export const WEB_AUTH_FUNCTION = "web_auth_verify";
/** SEP-45's reference contract, stellar/sep45-reference@3dcabc96 contracts/web_auth, as built by
 *  its attested release. It requires the account's and the server account's authorization and
 *  keeps no state. */
export const SEP45_REFERENCE_WASM_HASH =
  "3c8d0b8b347752e57abe0b50380401ca8f5793bc971b685fd072571bbf5d54cc";
/** SDF's mainnet deployment of that build, listed in SEP-45. */
export const MAINNET_WEB_AUTH_CONTRACT = "CALI6JC3MSNDGFRP7Z2OKUEPREHOJRRXKMJEWQDEFZPFGXALA45RAUTH";
export const HOME_DOMAIN = "lumenwipe.com";
export const WEB_AUTH_DOMAIN = "api.lumenwipe.com";

export const CONTRACT_CHALLENGE_TTL_SECONDS = 300;
/** How far past the ledger a challenge was issued at a signature may stay valid: the TTL at five
 *  seconds a ledger, with slack for slower ledgers. */
export const SIGNATURE_LEDGER_WINDOW = 70;
const MAX_ENTRIES_XDR_LENGTH = 16_384;
const MAX_ENTRIES = 2;
const READINESS_CACHE_MS = 10 * 60_000;
const SALT = /^[A-Za-z0-9_-]{22}$/;
const logger = new Logger("ContractAuth");

export interface ContractAuthConfig {
  secret: string;
  network: Network;
  /** The server account: its entry in every challenge proves the challenge came from here. */
  signer: Keypair;
  contractId: string;
}

/** Null when the network has no signing seed or no web authentication contract configured. */
export function contractAuthConfig(secret: string, network: Network): ContractAuthConfig | null {
  const contractId =
    network === "mainnet"
      ? MAINNET_WEB_AUTH_CONTRACT
      : process.env.INTEGRATOR_WEB_AUTH_CONTRACT_TESTNET?.trim();
  if (!contractId || !StrKey.isValidContract(contractId)) return null;
  const signer = keypairFromEnv("INTEGRATOR_WEB_AUTH_SIGNING_SEED", logger);
  return signer ? { secret, network, signer, contractId } : null;
}

/** What a provider is asked: the server account's ledger entry, the contract's code, and the
 *  enforcing simulation itself. */
export type ContractAuthRpc = Pick<rpc.Server, "getLedgerEntries" | "simulateTransaction">;

export interface ContractChallenge {
  /** Base64 XDR of the challenge's `SorobanAuthorizationEntry` list: the account's, unsigned,
   *  then the server account's, signed. */
  authorizationEntries: string;
  networkPassphrase: string;
  /** The last ledger a signature may be valid for. */
  validUntilLedger: number;
  expiresAt: string;
}

interface NonceFields {
  issuedAt: number;
  issuedLedger: number;
  salt: string;
}

function nonceMac(config: ContractAuthConfig, account: string, fields: NonceFields): Buffer {
  return hmac(
    config.secret,
    "contract-challenge",
    config.network,
    config.contractId,
    account,
    HOME_DOMAIN,
    WEB_AUTH_DOMAIN,
    config.signer.publicKey(),
    String(fields.issuedAt),
    String(fields.issuedLedger),
    fields.salt
  );
}

function formatNonce(config: ContractAuthConfig, account: string, fields: NonceFields): string {
  const mac = nonceMac(config, account, fields).toString("base64url");
  return `${fields.issuedAt}.${fields.issuedLedger}.${fields.salt}.${mac}`;
}

/** The nonce's fields when this server minted it for this account and network, and it has not
 *  expired by the server's own clock. */
function parseNonce(
  config: ContractAuthConfig,
  account: string,
  nonce: string,
  now: Date
): NonceFields | null {
  const parts = nonce.split(".");
  if (parts.length !== 4) return null;
  const [issuedRaw, ledgerRaw, salt, mac] = parts as [string, string, string, string];
  const issuedAt = Number(issuedRaw);
  const issuedLedger = Number(ledgerRaw);
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(issuedLedger) || issuedLedger < 1) {
    return null;
  }
  if (!SALT.test(salt)) return null;
  const fields = { issuedAt, issuedLedger, salt };
  if (!safeEqual(Buffer.from(mac, "base64url"), nonceMac(config, account, fields))) return null;
  const seconds = Math.floor(now.getTime() / 1000);
  if (issuedAt > seconds || seconds >= issuedAt + CONTRACT_CHALLENGE_TTL_SECONDS) return null;
  return fields;
}

function argsMap(config: ContractAuthConfig, account: string, nonce: string): xdr.ScVal {
  const pairs: [string, string][] = [
    ["account", account],
    ["home_domain", HOME_DOMAIN],
    ["nonce", nonce],
    ["web_auth_domain", WEB_AUTH_DOMAIN],
    ["web_auth_domain_account", config.signer.publicKey()],
  ];
  return xdr.ScVal.scvMap(
    pairs.map(
      ([key, val]) =>
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: xdr.ScVal.scvString(val) })
    )
  );
}

function invokeArgs(config: ContractAuthConfig, account: string, nonce: string) {
  return new xdr.InvokeContractArgs({
    contractAddress: new Address(config.contractId).toScAddress(),
    functionName: WEB_AUTH_FUNCTION,
    args: [argsMap(config, account, nonce)],
  });
}

function webAuthInvocation(
  config: ContractAuthConfig,
  account: string,
  nonce: string
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      invokeArgs(config, account, nonce)
    ),
    subInvocations: [],
  });
}

const randomInt64 = (): bigint => randomBytes(8).readBigInt64BE();

function unsignedEntry(
  address: string,
  invocation: xdr.SorobanAuthorizedInvocation
): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(address).toScAddress(),
        nonce: randomInt64(),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      })
    ),
    rootInvocation: invocation,
  });
}

function serverEntry(
  config: ContractAuthConfig,
  invocation: xdr.SorobanAuthorizedInvocation,
  validUntilLedger: number
): Promise<xdr.SorobanAuthorizationEntry> {
  return authorizeEntry(
    unsignedEntry(config.signer.publicKey(), invocation),
    config.signer,
    validUntilLedger,
    NETWORK_PASSPHRASES[config.network]
  );
}

const encodeEntries = (entries: xdr.SorobanAuthorizationEntry[]): string =>
  xdr.encodeArray(xdr.SorobanAuthorizationEntry, entries, "base64");

export async function buildContractChallenge(
  config: ContractAuthConfig,
  account: string,
  latestLedger: number,
  now: Date = new Date()
): Promise<ContractChallenge> {
  const fields: NonceFields = {
    issuedAt: Math.floor(now.getTime() / 1000),
    issuedLedger: latestLedger,
    salt: randomBytes(16).toString("base64url"),
  };
  const invocation = webAuthInvocation(config, account, formatNonce(config, account, fields));
  const validUntilLedger = latestLedger + SIGNATURE_LEDGER_WINDOW;
  return {
    authorizationEntries: encodeEntries([
      unsignedEntry(account, invocation),
      await serverEntry(config, invocation, validUntilLedger),
    ]),
    networkPassphrase: NETWORK_PASSPHRASES[config.network],
    validUntilLedger,
    expiresAt: new Date((fields.issuedAt + CONTRACT_CHALLENGE_TTL_SECONDS) * 1000).toISOString(),
  };
}

type CredentialKind = xdr.SorobanCredentials["type"];

/**
 * The credential kinds a challenge entry may carry, one row per kind the SDK knows. A reader gives
 * the entry's address credentials; null refuses the kind. The type is total over the SDK's union,
 * so a new kind (Protocol 31 proposes two, CAP-90, Draft) does not compile until someone writes its
 * row: supporting it is a deliberate change, never a default.
 *
 * Delegated signers (CAP-71, `sorobanCredentialsAddressWithDelegates`) are refused. The account's
 * own `__check_auth` decides who must have signed, through delegates the entry names and the
 * account must police itself, and each delegate runs its own code on every provider. That rests on
 * CAP-71's text and the SDK's structure, not on host behavior observed here. To accept it later:
 * a real testnet end to end with a deployed delegating account, a cap on the count and depth of
 * delegates, and a reviewed model of the host in `FakeWebAuthRpc`.
 */
const CREDENTIAL_READERS: {
  readonly [K in CredentialKind]:
    | ((credentials: Extract<xdr.SorobanCredentials, { type: K }>) => xdr.SorobanAddressCredentials)
    | null;
} = {
  sorobanCredentialsSourceAccount: null,
  sorobanCredentialsAddress: (credentials) => credentials.address,
  sorobanCredentialsAddressV2: (credentials) => credentials.addressV2,
  sorobanCredentialsAddressWithDelegates: null,
};

/** The address credentials of an entry when its kind is in the table and readable; null otherwise. */
function addressCredentialsOf(
  entry: xdr.SorobanAuthorizationEntry
): xdr.SorobanAddressCredentials | null {
  const credentials = entry.credentials;
  // TypeScript cannot correlate `credentials.type` with the reader its row holds, so the lookup is
  // widened to a reader of any kind; each row above is still checked against its own kind.
  const read = CREDENTIAL_READERS[credentials.type] as
    ((credentials: xdr.SorobanCredentials) => xdr.SorobanAddressCredentials) | null;
  return read ? read(credentials) : null;
}

/** The entries of a returned challenge, or null when the input is oversized or does not decode.
 *  The one decode both `readSignedContractChallenge` and `unsupportedCredentialKind` use. */
function decodeEntries(authorizationEntries: string): xdr.SorobanAuthorizationEntry[] | null {
  if (authorizationEntries.length > MAX_ENTRIES_XDR_LENGTH) return null;
  try {
    return xdr.decodeArray(xdr.SorobanAuthorizationEntry, authorizationEntries, "base64", {
      maxLength: MAX_ENTRIES,
    });
  } catch {
    return null;
  }
}

/**
 * The credential kind of the first entry whose kind the table refuses, so the refusal can name it;
 * null when the list does not decode or every entry's kind is supported. It reads nothing but the
 * credential kinds, and returns only the table's own kind names, never anything the caller wrote.
 */
export function unsupportedCredentialKind(authorizationEntries: string): CredentialKind | null {
  for (const entry of decodeEntries(authorizationEntries) ?? []) {
    if (!CREDENTIAL_READERS[entry.credentials.type]) return entry.credentials.type;
  }
  return null;
}

function nonceArgOf(entry: xdr.SorobanAuthorizationEntry): string | null {
  const fn = entry.rootInvocation.function;
  if (fn.type !== "sorobanAuthorizedFunctionTypeContractFn") return null;
  const [args, ...more] = fn.contractFn.args;
  if (!args || more.length > 0 || args.type !== "scvMap" || !args.map) return null;
  for (const { key, val } of args.map) {
    if (key.type === "scvSymbol" && key.sym.toString() === "nonce" && val.type === "scvString") {
      try {
        return val.str.toStringStrict();
      } catch {
        return null;
      }
    }
  }
  return null;
}

export interface SignedContractChallenge {
  /** The account's signed entry, exactly as the client sent it. */
  entry: xdr.SorobanAuthorizationEntry;
  /** Identifies the challenge for single use. */
  nonce: string;
  issuedLedger: number;
  expiresAt: Date;
}

/**
 * The account's signed entry from a returned challenge, when every check that needs no network
 * passes: the list decodes and is short, every entry is the account's or the server account's,
 * the account's credentials are of a kind in `CREDENTIAL_READERS`, a nonce this server minted for this account and network
 * that has not expired, exactly the invocation that nonce implies (contract, function, arguments,
 * no sub-invocations), and a signature that expires within the challenge's ledger window. The
 * server account's entry the client returns is ignored: the server signs its own again.
 */
export function readSignedContractChallenge(
  config: ContractAuthConfig,
  account: string,
  authorizationEntries: string,
  now: Date = new Date()
): SignedContractChallenge | null {
  const entries = decodeEntries(authorizationEntries);
  if (!entries) return null;
  const server = config.signer.publicKey();
  const mine: {
    entry: xdr.SorobanAuthorizationEntry;
    credentials: xdr.SorobanAddressCredentials;
  }[] = [];
  for (const entry of entries) {
    const credentials = addressCredentialsOf(entry);
    if (!credentials) return null;
    const address = Address.fromScAddress(credentials.address).toString();
    if (address === account) mine.push({ entry, credentials });
    else if (address !== server) return null;
  }
  if (mine.length !== 1) return null;
  const { entry, credentials } = mine[0]!;
  const nonce = nonceArgOf(entry);
  if (nonce === null) return null;
  const fields = parseNonce(config, account, nonce, now);
  if (!fields) return null;
  if (!entry.rootInvocation.equals(webAuthInvocation(config, account, nonce))) return null;
  if (credentials.signatureExpirationLedger > fields.issuedLedger + SIGNATURE_LEDGER_WINDOW) {
    return null;
  }
  return {
    entry,
    nonce,
    issuedLedger: fields.issuedLedger,
    expiresAt: new Date((fields.issuedAt + CONTRACT_CHALLENGE_TTL_SECONDS) * 1000),
  };
}

/** `misconfigured` is this server's own setup (no server account on the ledger, a contract that
 *  is not the attested build); `unavailable` is a provider that could not answer. */
export type ProviderVerdict = "ok" | "invalid" | "unavailable" | "misconfigured";

const ready = new WeakMap<object, Map<string, number>>();

/**
 * True when the provider shows the server account on the ledger and the web authentication
 * contract running the attested build. A yes is remembered per provider for ten minutes; a no or a
 * failed read is asked again next time.
 */
export async function isReady(
  config: ContractAuthConfig,
  provider: ContractAuthRpc,
  nowMs: number = Date.now()
): Promise<boolean> {
  const cacheKey = `${config.contractId}\n${config.signer.publicKey()}`;
  const cached = ready.get(provider)?.get(cacheKey);
  if (cached !== undefined && cached > nowMs) return true;
  const instanceKey = new Contract(config.contractId).getFootprint();
  const accountKey = xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({ accountId: config.signer.xdrAccountId() })
  );
  const { entries } = await provider.getLedgerEntries(instanceKey, accountKey);
  const instance = entries.find((e) => e.key.equals(instanceKey));
  const account = entries.find((e) => e.key.equals(accountKey));
  if (!instance || !account) return false;
  let code;
  try {
    code = codeRefOf(instanceOfEntry(instance.val));
  } catch {
    return false;
  }
  if (code?.kind !== "wasm" || code.wasmHash !== SEP45_REFERENCE_WASM_HASH) return false;
  const byKey = ready.get(provider) ?? new Map<string, number>();
  byKey.set(cacheKey, nowMs + READINESS_CACHE_MS);
  ready.set(provider, byKey);
  return true;
}

function simulationTransaction(
  config: ContractAuthConfig,
  account: string,
  nonce: string,
  auth: xdr.SorobanAuthorizationEntry[]
): Transaction {
  return new TransactionBuilder(new Account(config.signer.publicKey(), "0"), {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASES[config.network],
  })
    .addOperation(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(invokeArgs(config, account, nonce)),
        auth,
      })
    )
    .setTimeout(30)
    .build();
}

async function verdictOf(
  config: ContractAuthConfig,
  provider: ContractAuthRpc,
  tx: Transaction
): Promise<ProviderVerdict> {
  try {
    if (!(await isReady(config, provider))) return "misconfigured";
    const simulation = await provider.simulateTransaction(tx, undefined, "enforce", false);
    if (rpc.Api.isSimulationError(simulation)) return "invalid";
    if (rpc.Api.isSimulationRestore(simulation)) return "unavailable";
    return rpc.Api.isSimulationSuccess(simulation) && simulation.result ? "ok" : "unavailable";
  } catch {
    return "unavailable";
  }
}

/**
 * Runs the enforcing simulation on every provider and combines the answers so that a session
 * needs all of them: one refusal refuses, and otherwise one provider that could not answer, or
 * that shows this server misconfigured, withholds the session.
 */
export async function verifyOnEveryProvider(
  config: ContractAuthConfig,
  account: string,
  signed: SignedContractChallenge,
  providers: ContractAuthRpc[]
): Promise<ProviderVerdict> {
  if (providers.length === 0) return "misconfigured";
  const invocation = webAuthInvocation(config, account, signed.nonce);
  const server = await serverEntry(
    config,
    invocation,
    signed.issuedLedger + SIGNATURE_LEDGER_WINDOW
  );
  const tx = simulationTransaction(config, account, signed.nonce, [signed.entry, server]);
  const verdicts = await Promise.all(providers.map((p) => verdictOf(config, p, tx)));
  for (const verdict of ["invalid", "misconfigured", "unavailable"] as const) {
    if (verdicts.includes(verdict)) return verdict;
  }
  return "ok";
}

/** The network reads a contract sign-in needs, so tests can stand in for the providers. */
export interface ContractAuthNetwork {
  latestLedger(network: Network): Promise<number>;
  providers(network: Network): ContractAuthRpc[];
}

export const CONTRACT_AUTH_NETWORK = Symbol("CONTRACT_AUTH_NETWORK");
