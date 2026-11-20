import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Address, Keypair, Networks, StrKey, authorizeEntry, xdr } from "@stellar/stellar-sdk";
import {
  CONTRACT_CHALLENGE_TTL_SECONDS,
  MAINNET_WEB_AUTH_CONTRACT,
  SIGNATURE_LEDGER_WINDOW,
  buildContractChallenge,
  contractAuthConfig,
  isReady,
  readSignedContractChallenge,
  verifyOnEveryProvider,
  type ContractAuthConfig,
} from "@/integrator/contract-auth";
import { FakeWebAuthRpc, type FakeAccount } from "../support/fake-web-auth-rpc";

const SECRET = "test-integrator-auth-secret-0123456789";
const NOW = new Date("2026-01-01T00:00:00Z");
const LEDGER = 1_000;
const SERVER = Keypair.random();
const TESTNET_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 9));

const contractAddress = (seed: number): string => StrKey.encodeContract(Buffer.alloc(32, seed));

const ENV_NAMES = ["INTEGRATOR_WEB_AUTH_SIGNING_SEED", "INTEGRATOR_WEB_AUTH_CONTRACT_TESTNET"];
const savedEnv = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));

function setEnv(values: Record<string, string | undefined>): void {
  for (const name of ENV_NAMES) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

beforeEach(() =>
  setEnv({
    INTEGRATOR_WEB_AUTH_SIGNING_SEED: SERVER.secret(),
    INTEGRATOR_WEB_AUTH_CONTRACT_TESTNET: TESTNET_CONTRACT,
  })
);

afterEach(() => setEnv(Object.fromEntries(savedEnv)));

function config(network: "testnet" | "mainnet" = "testnet"): ContractAuthConfig {
  const c = contractAuthConfig(SECRET, network);
  if (!c) throw new Error("test config is incomplete");
  return c;
}

function provider(
  accounts: [string, FakeAccount][],
  overrides: Partial<ConstructorParameters<typeof FakeWebAuthRpc>[0]> = {},
  cfg: ContractAuthConfig = config()
): FakeWebAuthRpc {
  return new FakeWebAuthRpc({
    contractId: cfg.contractId,
    serverAccount: SERVER.publicKey(),
    networkPassphrase: cfg.network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET,
    accounts: new Map(accounts),
    latestLedger: LEDGER + 5,
    ...overrides,
  });
}

const decode = (b64: string) => xdr.decodeArray(xdr.SorobanAuthorizationEntry, b64, "base64");
const encode = (entries: xdr.SorobanAuthorizationEntry[]) =>
  xdr.encodeArray(xdr.SorobanAuthorizationEntry, entries, "base64");

async function signChallenge(
  challenge: { authorizationEntries: string; validUntilLedger: number },
  signer: Keypair,
  passphrase: string = Networks.TESTNET,
  validUntil: number = challenge.validUntilLedger
): Promise<string> {
  const [client, server] = decode(challenge.authorizationEntries);
  return encode([await authorizeEntry(client!, signer, validUntil, passphrase), server!]);
}

async function signIn(
  account: string,
  signer: Keypair,
  providers: FakeWebAuthRpc[],
  cfg: ContractAuthConfig = config()
) {
  const challenge = await buildContractChallenge(cfg, account, LEDGER, NOW);
  const signed = readSignedContractChallenge(
    cfg,
    account,
    await signChallenge(
      challenge,
      signer,
      cfg.network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET
    ),
    NOW
  );
  if (!signed) return "unread";
  return verifyOnEveryProvider(cfg, account, signed, providers);
}

describe("contractAuthConfig", () => {
  test("needs the signing seed, and on testnet the contract", () => {
    setEnv({});
    expect(contractAuthConfig(SECRET, "testnet")).toBeNull();
    setEnv({ INTEGRATOR_WEB_AUTH_SIGNING_SEED: SERVER.secret() });
    expect(contractAuthConfig(SECRET, "testnet")).toBeNull();
    expect(contractAuthConfig(SECRET, "mainnet")?.contractId).toBe(MAINNET_WEB_AUTH_CONTRACT);
    setEnv({ INTEGRATOR_WEB_AUTH_SIGNING_SEED: SERVER.publicKey() });
    expect(contractAuthConfig(SECRET, "mainnet")).toBeNull();
  });

  test("ignores a testnet contract setting on mainnet", () => {
    expect(config("mainnet").contractId).toBe(MAINNET_WEB_AUTH_CONTRACT);
  });
});

describe("buildContractChallenge", () => {
  test("the account's entry is unsigned and the server's is signed for web_auth_verify", async () => {
    const account = contractAddress(1);
    const challenge = await buildContractChallenge(config(), account, LEDGER, NOW);
    const [client, server] = decode(challenge.authorizationEntries);
    expect(client!.credentials.type).toBe("sorobanCredentialsAddress");
    expect(server!.credentials.type).toBe("sorobanCredentialsAddress");
    if (client!.credentials.type !== "sorobanCredentialsAddress") throw new Error();
    if (server!.credentials.type !== "sorobanCredentialsAddress") throw new Error();
    expect(Address.fromScAddress(client!.credentials.address.address).toString()).toBe(account);
    expect(client!.credentials.address.signature.type).toBe("scvVoid");
    expect(server!.credentials.address.signature.type).toBe("scvVec");
    expect(server!.credentials.address.signatureExpirationLedger).toBe(
      LEDGER + SIGNATURE_LEDGER_WINDOW
    );
    expect(challenge).toMatchObject({
      networkPassphrase: Networks.TESTNET,
      validUntilLedger: LEDGER + SIGNATURE_LEDGER_WINDOW,
      expiresAt: new Date(NOW.getTime() + CONTRACT_CHALLENGE_TTL_SECONDS * 1000).toISOString(),
    });
  });

  test("two challenges for the same account and second carry different nonces", async () => {
    const account = contractAddress(1);
    const a = await buildContractChallenge(config(), account, LEDGER, NOW);
    const b = await buildContractChallenge(config(), account, LEDGER, NOW);
    expect(a.authorizationEntries).not.toBe(b.authorizationEntries);
  });
});

describe("contract-account sign-in", () => {
  test("an account signed by its own key signs in, simulated in enforcing mode", async () => {
    const owner = Keypair.random();
    const account = contractAddress(1);
    const rpc = provider([[account, { kind: "ed25519", owner }]]);
    expect(await signIn(account, owner, [rpc])).toBe("ok");
    expect(rpc.authModes).toEqual(["enforce"]);
  });

  test("a forged authorization is refused: signed by a key the account does not accept", async () => {
    const account = contractAddress(1);
    const rpc = provider([[account, { kind: "ed25519", owner: Keypair.random() }]]);
    expect(await signIn(account, Keypair.random(), [rpc])).toBe("invalid");
  });

  test("an unsigned entry is refused", async () => {
    const account = contractAddress(1);
    const rpc = provider([[account, { kind: "ed25519", owner: Keypair.random() }]]);
    const challenge = await buildContractChallenge(config(), account, LEDGER, NOW);
    const signed = readSignedContractChallenge(
      config(),
      account,
      challenge.authorizationEntries,
      NOW
    );
    expect(await verifyOnEveryProvider(config(), account, signed!, [rpc])).toBe("invalid");
  });

  test("a contract whose __check_auth panics is refused", async () => {
    const account = contractAddress(1);
    const rpc = provider([[account, { kind: "panic" }]]);
    expect(await signIn(account, Keypair.random(), [rpc])).toBe("invalid");
  });

  test("an address with no account contract is refused", async () => {
    const rpc = provider([]);
    expect(await signIn(contractAddress(1), Keypair.random(), [rpc])).toBe("invalid");
  });

  test("a contract whose __check_auth always succeeds signs in, for its own address only", async () => {
    const open = contractAddress(1);
    const victim = contractAddress(2);
    const owner = Keypair.random();
    const rpc = provider([
      [open, { kind: "always-ok" }],
      [victim, { kind: "ed25519", owner }],
    ]);
    expect(await signIn(open, Keypair.random(), [rpc])).toBe("ok");
    expect(await signIn(victim, Keypair.random(), [rpc])).toBe("invalid");

    const challenge = await buildContractChallenge(config(), open, LEDGER, NOW);
    const signed = await signChallenge(challenge, Keypair.random());
    expect(readSignedContractChallenge(config(), victim, signed, NOW)).toBeNull();
  });

  test("the session needs every provider: one refusal refuses even when the first agrees", async () => {
    const owner = Keypair.random();
    const account = contractAddress(1);
    const agrees = provider([[account, { kind: "ed25519", owner }]]);
    const refuses = provider([[account, { kind: "ed25519", owner: Keypair.random() }]]);
    expect(await signIn(account, owner, [agrees, refuses])).toBe("invalid");
    expect(agrees.simulations).toBe(1);
    expect(refuses.simulations).toBe(1);
  });

  test("a provider that cannot answer withholds the session", async () => {
    const owner = Keypair.random();
    const account = contractAddress(1);
    const agrees = provider([[account, { kind: "ed25519", owner }]]);
    expect(await signIn(account, owner, [agrees, provider([], { failure: "throw" })])).toBe(
      "unavailable"
    );
    expect(await signIn(account, owner, [agrees, provider([], { failure: "restore" })])).toBe(
      "unavailable"
    );
    const challenge = await buildContractChallenge(config(), account, LEDGER, NOW);
    const signed = readSignedContractChallenge(
      config(),
      account,
      await signChallenge(challenge, owner),
      NOW
    );
    expect(await verifyOnEveryProvider(config(), account, signed!, [])).toBe("misconfigured");
  });

  test("a web authentication contract that is not the attested build is never simulated", async () => {
    const owner = Keypair.random();
    const account = contractAddress(1);
    const rpc = provider([[account, { kind: "ed25519", owner }]], { wasmHash: "00".repeat(32) });
    expect(await signIn(account, owner, [rpc])).toBe("misconfigured");
    expect(rpc.simulations).toBe(0);
  });

  test("a server account missing from the ledger is reported as this server's setup", async () => {
    const owner = Keypair.random();
    const account = contractAddress(1);
    const rpc = provider([[account, { kind: "ed25519", owner }]], { serverAccountExists: false });
    expect(await signIn(account, owner, [rpc])).toBe("misconfigured");
  });

  test("v2 address credentials are accepted", async () => {
    const owner = Keypair.random();
    const account = contractAddress(1);
    const rpc = provider([[account, { kind: "ed25519", owner }]]);
    const challenge = await buildContractChallenge(config(), account, LEDGER, NOW);
    const [client, server] = decode(challenge.authorizationEntries);
    if (client!.credentials.type !== "sorobanCredentialsAddress") throw new Error();
    const v2 = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(client!.credentials.address),
      rootInvocation: client!.rootInvocation,
    });
    const signedXdr = encode([
      await authorizeEntry(v2, owner, challenge.validUntilLedger, Networks.TESTNET),
      server!,
    ]);
    const signed = readSignedContractChallenge(config(), account, signedXdr, NOW);
    expect(signed).not.toBeNull();
    expect(await verifyOnEveryProvider(config(), account, signed!, [rpc])).toBe("ok");
  });
});

describe("readSignedContractChallenge", () => {
  const account = contractAddress(1);
  const owner = Keypair.random();

  async function signed(cfg = config()) {
    const challenge = await buildContractChallenge(cfg, account, LEDGER, NOW);
    return { challenge, xdrs: await signChallenge(challenge, owner) };
  }

  test("reads a well-formed signed challenge", async () => {
    const { xdrs } = await signed();
    const read = readSignedContractChallenge(config(), account, xdrs, NOW);
    expect(read?.issuedLedger).toBe(LEDGER);
    expect(read?.expiresAt.getTime()).toBe(NOW.getTime() + CONTRACT_CHALLENGE_TTL_SECONDS * 1000);
  });

  test("an expired challenge is refused, one still inside its window is read", async () => {
    const { xdrs } = await signed();
    const ttl = CONTRACT_CHALLENGE_TTL_SECONDS * 1000;
    expect(
      readSignedContractChallenge(config(), account, xdrs, new Date(NOW.getTime() + ttl))
    ).toBeNull();
    expect(
      readSignedContractChallenge(config(), account, xdrs, new Date(NOW.getTime() + ttl - 1000))
    ).not.toBeNull();
    expect(
      readSignedContractChallenge(config(), account, xdrs, new Date(NOW.getTime() - 1000))
    ).toBeNull();
  });

  test("a challenge issued for the other network is refused", async () => {
    const { xdrs } = await signed();
    const mainnet = { ...config(), network: "mainnet" as const, contractId: TESTNET_CONTRACT };
    expect(readSignedContractChallenge(mainnet, account, xdrs, NOW)).toBeNull();
  });

  test("a challenge for a different web authentication contract is refused", async () => {
    const { xdrs } = await signed();
    const other = { ...config(), contractId: contractAddress(3) };
    expect(readSignedContractChallenge(other, account, xdrs, NOW)).toBeNull();
  });

  test("a nonce this server did not mint is refused", async () => {
    const { xdrs } = await signed({ ...config(), secret: "another-secret-0123456789-0123456789" });
    expect(readSignedContractChallenge(config(), account, xdrs, NOW)).toBeNull();
  });

  test("an entry whose credentials name another address than its account argument is refused", async () => {
    const challenge = await buildContractChallenge(config(), account, LEDGER, NOW);
    const [client, server] = decode(challenge.authorizationEntries);
    if (client!.credentials.type !== "sorobanCredentialsAddress") throw new Error();
    const moved = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(contractAddress(2)).toScAddress(),
          nonce: client!.credentials.address.nonce,
          signatureExpirationLedger: 0,
          signature: xdr.ScVal.scvVoid(),
        })
      ),
      rootInvocation: client!.rootInvocation,
    });
    const xdrs = encode([
      await authorizeEntry(moved, owner, challenge.validUntilLedger, Networks.TESTNET),
      server!,
    ]);
    expect(readSignedContractChallenge(config(), contractAddress(2), xdrs, NOW)).toBeNull();
    expect(readSignedContractChallenge(config(), account, xdrs, NOW)).toBeNull();
  });

  test("an authorization of another contract or function, with this challenge's arguments, is refused", async () => {
    const challenge = await buildContractChallenge(config(), account, LEDGER, NOW);
    const [client, server] = decode(challenge.authorizationEntries);
    const fn = client!.rootInvocation.function;
    if (fn.type !== "sorobanAuthorizedFunctionTypeContractFn") throw new Error();
    const retargeted = [
      {
        contractAddress: new Address(contractAddress(3)).toScAddress(),
        functionName: "web_auth_verify",
      },
      { contractAddress: fn.contractFn.contractAddress, functionName: "transfer" },
    ];
    for (const target of retargeted) {
      const entry = new xdr.SorobanAuthorizationEntry({
        credentials: client!.credentials,
        rootInvocation: new xdr.SorobanAuthorizedInvocation({
          function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
            new xdr.InvokeContractArgs({ ...target, args: fn.contractFn.args })
          ),
          subInvocations: [],
        }),
      });
      const xdrs = encode([
        await authorizeEntry(entry, owner, challenge.validUntilLedger, Networks.TESTNET),
        server!,
      ]);
      expect(readSignedContractChallenge(config(), account, xdrs, NOW)).toBeNull();
    }
  });

  test("an authorization with a sub-invocation is refused", async () => {
    const challenge = await buildContractChallenge(config(), account, LEDGER, NOW);
    const [client, server] = decode(challenge.authorizationEntries);
    const widened = new xdr.SorobanAuthorizationEntry({
      credentials: client!.credentials,
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: client!.rootInvocation.function,
        subInvocations: [client!.rootInvocation],
      }),
    });
    const xdrs = encode([
      await authorizeEntry(widened, owner, challenge.validUntilLedger, Networks.TESTNET),
      server!,
    ]);
    expect(readSignedContractChallenge(config(), account, xdrs, NOW)).toBeNull();
  });

  test("a signature valid past the challenge's ledger window is refused", async () => {
    const challenge = await buildContractChallenge(config(), account, LEDGER, NOW);
    const late = await signChallenge(
      challenge,
      owner,
      Networks.TESTNET,
      challenge.validUntilLedger + 1
    );
    expect(readSignedContractChallenge(config(), account, late, NOW)).toBeNull();
    const onTime = await signChallenge(
      challenge,
      owner,
      Networks.TESTNET,
      challenge.validUntilLedger
    );
    expect(readSignedContractChallenge(config(), account, onTime, NOW)).not.toBeNull();
  });

  test("source-account and delegated credentials are refused", async () => {
    const challenge = await buildContractChallenge(config(), account, LEDGER, NOW);
    const [client] = decode(challenge.authorizationEntries);
    const source = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: client!.rootInvocation,
    });
    expect(
      readSignedContractChallenge(config(), account, encode([source, client!]), NOW)
    ).toBeNull();
  });

  test("an entry for a third address, a duplicate entry, garbage and oversized input are refused", async () => {
    const { challenge, xdrs } = await signed();
    const [client] = decode(xdrs);
    const [, server] = decode(challenge.authorizationEntries);
    expect(
      readSignedContractChallenge(config(), account, encode([client!, client!]), NOW)
    ).toBeNull();
    expect(readSignedContractChallenge(config(), account, encode([server!]), NOW)).toBeNull();
    expect(
      readSignedContractChallenge(config(), account, encode([client!, server!, server!]), NOW)
    ).toBeNull();
    expect(readSignedContractChallenge(config(), account, "not xdr", NOW)).toBeNull();
    expect(readSignedContractChallenge(config(), account, "A".repeat(20_000), NOW)).toBeNull();
    expect(readSignedContractChallenge(config(), account, encode([client!]), NOW)).not.toBeNull();
  });
});

describe("isReady", () => {
  test("remembers a yes for ten minutes, and asks again after a no", async () => {
    const rpc = provider([]);
    expect(await isReady(config(), rpc, 0)).toBe(true);
    expect(await isReady(config(), rpc, 9 * 60_000)).toBe(true);
    expect(rpc.ledgerReads).toBe(1);
    expect(await isReady(config(), rpc, 11 * 60_000)).toBe(true);
    expect(rpc.ledgerReads).toBe(2);

    const missing = provider([], { serverAccountExists: false });
    expect(await isReady(config(), missing, 0)).toBe(false);
    expect(await isReady(config(), missing, 0)).toBe(false);
    expect(missing.ledgerReads).toBe(2);
  });
});
