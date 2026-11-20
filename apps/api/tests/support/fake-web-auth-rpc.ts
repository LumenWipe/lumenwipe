import {
  Address,
  Contract,
  Keypair,
  StrKey,
  buildAuthorizationEntryPreimage,
  hash,
  xdr,
  type rpc,
  type Transaction,
} from "@stellar/stellar-sdk";
import {
  WEB_AUTH_FUNCTION,
  SEP45_REFERENCE_WASM_HASH,
  type ContractAuthRpc,
} from "@/integrator/contract-auth";

/** How a fake contract account's `__check_auth` behaves. */
export type FakeAccount =
  { kind: "ed25519"; owner: Keypair } | { kind: "always-ok" } | { kind: "panic" };

export interface FakeWebAuthRpcOptions {
  contractId: string;
  serverAccount: string;
  networkPassphrase: string;
  accounts: Map<string, FakeAccount>;
  latestLedger?: number;
  wasmHash?: string;
  serverAccountExists?: boolean;
  /** A provider that cannot answer, or answers with a restore instead of a result. */
  failure?: "throw" | "restore";
}

const failed = (error: string, latestLedger: number) =>
  ({
    id: "1",
    latestLedger,
    events: [],
    error,
    _parsed: true,
  }) as unknown as rpc.Api.SimulateTransactionResponse;

const succeeded = (latestLedger: number, restore = false) =>
  ({
    id: "1",
    latestLedger,
    events: [],
    _parsed: true,
    minResourceFee: "100",
    transactionData: {},
    result: { auth: [], retval: xdr.ScVal.scvVoid() },
    ...(restore && { restorePreamble: { minResourceFee: "100", transactionData: {} } }),
  }) as unknown as rpc.Api.SimulateTransactionResponse;

/** The `public_key`/`signature` pairs an account signature carries, in the form `authorizeEntry`
 *  writes for a key pair. */
function signaturePairs(signature: xdr.ScVal): { publicKey: Buffer; signature: Buffer }[] | null {
  if (signature.type !== "scvVec" || !signature.vec) return null;
  const pairs: { publicKey: Buffer; signature: Buffer }[] = [];
  for (const item of signature.vec) {
    if (item.type !== "scvMap" || !item.map) return null;
    const field = (name: string) =>
      item.map!.find((e) => e.key.type === "scvSymbol" && e.key.sym.toString() === name)?.val;
    const pk = field("public_key");
    const sig = field("signature");
    if (pk?.type !== "scvBytes" || sig?.type !== "scvBytes") return null;
    pairs.push({
      publicKey: Buffer.from(pk.bytes.toBytes()),
      signature: Buffer.from(sig.bytes.toBytes()),
    });
  }
  return pairs;
}

function signedBy(keypair: Keypair, signature: xdr.ScVal, payload: Uint8Array): boolean {
  const pairs = signaturePairs(signature);
  return (
    !!pairs &&
    pairs.length === 1 &&
    pairs[0]!.publicKey.equals(keypair.rawPublicKey()) &&
    keypair.verify(Buffer.from(payload), pairs[0]!.signature)
  );
}

function addressCredentials(entry: xdr.SorobanAuthorizationEntry) {
  const c = entry.credentials;
  if (c.type === "sorobanCredentialsAddress") return c.address;
  if (c.type === "sorobanCredentialsAddressV2") return c.addressV2;
  return null;
}

/**
 * Stands in for a provider's simulation of `web_auth_verify` the way the host runs it in enforcing
 * mode: both addresses the contract calls `require_auth` on need an entry for exactly this call,
 * unexpired, whose signature their own account logic accepts. Recording mode checks no signature,
 * as on a real node.
 */
export class FakeWebAuthRpc implements ContractAuthRpc {
  readonly authModes: unknown[] = [];
  simulations = 0;
  ledgerReads = 0;
  latestLedger: number;

  constructor(private readonly options: FakeWebAuthRpcOptions) {
    this.latestLedger = options.latestLedger ?? 1_000;
  }

  async getLedgerEntries(...keys: xdr.LedgerKey[]): Promise<rpc.Api.GetLedgerEntriesResponse> {
    this.ledgerReads++;
    if (this.options.failure === "throw") throw new Error("provider down");
    const instanceKey = new Contract(this.options.contractId).getFootprint();
    const entries: rpc.Api.LedgerEntryResult[] = [];
    for (const key of keys) {
      if (key.equals(instanceKey)) {
        entries.push({ key, val: this.instance() });
      } else if (
        key.type === "account" &&
        StrKey.encodeEd25519PublicKey(Buffer.from(key.account.accountId.ed25519.toBytes())) ===
          this.options.serverAccount &&
        this.options.serverAccountExists !== false
      ) {
        entries.push({ key, val: this.account() });
      }
    }
    return { entries, latestLedger: this.latestLedger };
  }

  private instance(): xdr.LedgerEntryData {
    return xdr.LedgerEntryData.contractData(
      new xdr.ContractDataEntry({
        ext: xdr.ExtensionPoint.fromJson("v0"),
        contract: new Address(this.options.contractId).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent,
        val: xdr.ScVal.scvContractInstance(
          new xdr.ScContractInstance({
            executable: xdr.ContractExecutable.contractExecutableWasm(
              Buffer.from(this.options.wasmHash ?? SEP45_REFERENCE_WASM_HASH, "hex")
            ),
            storage: null,
          })
        ),
      })
    );
  }

  private account(): xdr.LedgerEntryData {
    return xdr.LedgerEntryData.fromJson({
      account: {
        account_id: this.options.serverAccount,
        balance: "20000000",
        seq_num: "1",
        num_sub_entries: 0,
        inflation_dest: null,
        flags: 0,
        home_domain: "",
        thresholds: "01000000",
        signers: [],
        ext: "v0",
      },
    });
  }

  async simulateTransaction(
    tx: Transaction | unknown,
    _resources?: unknown,
    authMode?: unknown
  ): Promise<rpc.Api.SimulateTransactionResponse> {
    this.simulations++;
    this.authModes.push(authMode);
    if (this.options.failure === "throw") throw new Error("provider down");
    if (this.options.failure === "restore") return succeeded(this.latestLedger, true);
    const op = (tx as Transaction).operations[0];
    if (!op || op.type !== "invokeHostFunction")
      return failed("not an invocation", this.latestLedger);
    const func = op.func;
    if (func.type !== "hostFunctionTypeInvokeContract")
      return failed("not a call", this.latestLedger);
    const call = func.invokeContract;
    if (Address.fromScAddress(call.contractAddress).toString() !== this.options.contractId) {
      return failed("unknown contract", this.latestLedger);
    }
    if (call.functionName.toString() !== WEB_AUTH_FUNCTION) {
      return failed("unknown function", this.latestLedger);
    }
    if (authMode !== "enforce") return succeeded(this.latestLedger);

    const args = call.args[0];
    const arg = (name: string) =>
      args?.type === "scvMap"
        ? args.map?.find((e) => e.key.type === "scvSymbol" && e.key.sym.toString() === name)?.val
        : undefined;
    const account = arg("account");
    const server = arg("web_auth_domain_account");
    if (account?.type !== "scvString" || server?.type !== "scvString") {
      return failed("MissingArgument", this.latestLedger);
    }
    const expected = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call),
      subInvocations: [],
    });
    for (const address of [account.str.toString(), server.str.toString()]) {
      const error = this.checkAuth(address, op.auth ?? [], expected);
      if (error) return failed(error, this.latestLedger);
    }
    return succeeded(this.latestLedger);
  }

  private checkAuth(
    address: string,
    auth: xdr.SorobanAuthorizationEntry[],
    expected: xdr.SorobanAuthorizedInvocation
  ): string | null {
    const entry = auth.find((e) => {
      const creds = addressCredentials(e);
      return creds && Address.fromScAddress(creds.address).toString() === address;
    });
    const creds = entry && addressCredentials(entry);
    if (!entry || !creds) return `no authorization for ${address}`;
    if (!entry.rootInvocation.equals(expected)) return "authorization does not match the call";
    if (creds.signatureExpirationLedger <= this.latestLedger) return "signature expired";
    const payload = hash(
      Buffer.from(
        buildAuthorizationEntryPreimage(
          entry,
          creds.signatureExpirationLedger,
          this.options.networkPassphrase
        ).toXDR()
      )
    );
    if (StrKey.isValidEd25519PublicKey(address)) {
      if (address !== this.options.serverAccount || this.options.serverAccountExists === false) {
        return "account missing";
      }
      return signedBy(Keypair.fromPublicKey(address), creds.signature, payload)
        ? null
        : "bad signature";
    }
    const behavior = this.options.accounts.get(address);
    if (!behavior) return "contract missing";
    if (behavior.kind === "panic") return "__check_auth panicked";
    if (behavior.kind === "always-ok") return null;
    return signedBy(behavior.owner, creds.signature, payload) ? null : "bad signature";
  }
}
