import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { HttpException } from "@nestjs/common";
import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host";
import type { ConfigService } from "@nestjs/config";
import {
  Keypair,
  Networks,
  StrKey,
  authorizeEntry,
  buildWithDelegatesEntry,
  xdr,
} from "@stellar/stellar-sdk";
import { ApiKeyDirectory } from "@/auth/api-key-directory";
import { ApiKeyService } from "@/auth/api-key.service";
import type { ApiKeyRecord, ApiKeyStore, NewApiKeyOptions } from "@/auth/api-key-store";
import { AuditLogger } from "@/common/audit-logger";
import { MeteringService } from "@/metering/metering.service";
import { InMemoryUsageStore } from "@/metering/usage-store";
import { IntegratorController } from "@/integrator/integrator.controller";
import { IntegratorGuard, type IntegratorRequest } from "@/integrator/integrator.guard";
import { issueSession } from "@/integrator/wallet-auth";
import type { ContractAuthNetwork } from "@/integrator/contract-auth";
import {
  InMemoryUsedChallengeStore,
  type UsedChallengeStore,
} from "@/integrator/used-challenge-store";
import { fail } from "@/common/fail";
import { FakeWebAuthRpc, type FakeAccount } from "../support/fake-web-auth-rpc";
import { requestPair } from "../support/request-context";

const SECRET = "test-integrator-auth-secret-0123456789";

class MemoryStore implements ApiKeyStore {
  records: ApiKeyRecord[] = [];
  async create(owner: string, options: NewApiKeyOptions = {}) {
    const record: ApiKeyRecord = {
      hash: `hash-${this.records.length}`,
      owner,
      createdAt: new Date(),
      revokedAt: null,
      rotatedFrom: null,
      rateLimit: null,
      label: options.label ?? null,
      networks: options.networks ?? null,
      lastUsedAt: null,
    };
    this.records.push(record);
    return { raw: `lw_raw-${record.hash}`, record };
  }
  async resolve() {
    return null;
  }
  async findByHash(hash: string) {
    return this.records.find((r) => r.hash === hash) ?? null;
  }
  async listByOwner(owner: string) {
    return this.records.filter((r) => r.owner === owner);
  }
  async revoke(hash: string) {
    const r = this.records.find((x) => x.hash === hash);
    if (r) r.revokedAt = new Date();
    return Boolean(r);
  }
  async rotate(hash: string) {
    const old = this.records.find((x) => x.hash === hash && !x.revokedAt);
    if (!old) return null;
    old.revokedAt = new Date();
    const next = await this.create(old.owner, { label: old.label, networks: old.networks });
    return next;
  }
  async recordLastUsed() {}
}

function codeOf(e: unknown): string | null {
  return e instanceof HttpException
    ? (e.getResponse() as { error: { code: string } }).error.code
    : null;
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return null;
}

const saved = {
  secret: process.env.INTEGRATOR_AUTH_SECRET,
  fs: process.env.FIRESTORE_PROJECT_ID,
  seed: process.env.INTEGRATOR_WEB_AUTH_SIGNING_SEED,
  testnet: process.env.INTEGRATOR_WEB_AUTH_CONTRACT_TESTNET,
};
const SERVER = Keypair.random();
const WEB_AUTH_TESTNET = StrKey.encodeContract(Buffer.alloc(32, 9));

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  process.env.INTEGRATOR_AUTH_SECRET = SECRET;
  process.env.FIRESTORE_PROJECT_ID = "test-project";
  process.env.INTEGRATOR_WEB_AUTH_SIGNING_SEED = SERVER.secret();
  process.env.INTEGRATOR_WEB_AUTH_CONTRACT_TESTNET = WEB_AUTH_TESTNET;
});

afterEach(() => {
  if (saved.secret === undefined) delete process.env.INTEGRATOR_AUTH_SECRET;
  else process.env.INTEGRATOR_AUTH_SECRET = saved.secret;
  if (saved.fs === undefined) delete process.env.FIRESTORE_PROJECT_ID;
  else process.env.FIRESTORE_PROJECT_ID = saved.fs;
  restore("INTEGRATOR_WEB_AUTH_SIGNING_SEED", saved.seed);
  restore("INTEGRATOR_WEB_AUTH_CONTRACT_TESTNET", saved.testnet);
});

const LEDGER = 1_000;

function fakeProvider(accounts: [string, FakeAccount][]): FakeWebAuthRpc {
  return new FakeWebAuthRpc({
    contractId: WEB_AUTH_TESTNET,
    serverAccount: SERVER.publicKey(),
    networkPassphrase: Networks.TESTNET,
    accounts: new Map(accounts),
    latestLedger: LEDGER + 5,
  });
}

function setup(
  providers: FakeWebAuthRpc[] = [fakeProvider([])],
  usedChallenges: UsedChallengeStore = new InMemoryUsedChallengeStore()
) {
  const network: ContractAuthNetwork = {
    latestLedger: async () => LEDGER,
    providers: () => providers,
  };
  const store = new MemoryStore();
  const directory = new ApiKeyDirectory(
    new ApiKeyService({ get: () => "" } as unknown as ConfigService),
    store
  );
  const controller = new IntegratorController(
    store,
    new MeteringService(new InMemoryUsageStore(), () => new Date()),
    directory,
    new AuditLogger(),
    usedChallenges,
    network
  );
  return { store, controller };
}

function asUser(address: string): IntegratorRequest {
  return Object.assign(requestPair().req, { integratorAddress: address });
}

describe("key ownership", () => {
  test("a wallet cannot revoke or rotate another wallet's key", async () => {
    const { controller, store } = setup();
    const alice = Keypair.random().publicKey();
    const mallory = Keypair.random().publicKey();
    const { record } = await store.create(alice);

    expect(codeOf(await rejection(controller.revoke(asUser(mallory), record.hash)))).toBe(
      "api_key_not_found"
    );
    expect(codeOf(await rejection(controller.rotate(asUser(mallory), record.hash)))).toBe(
      "api_key_not_found"
    );
    expect(record.revokedAt).toBeNull();
  });

  test("ownership is checked by hash lookup, never by listing every key", async () => {
    const { controller, store } = setup();
    const alice = Keypair.random().publicKey();
    const { record } = await store.create(alice);
    store.listByOwner = async () => {
      throw new Error("listByOwner must not be used for ownership");
    };

    await controller.revoke(asUser(alice), record.hash);
    expect(record.revokedAt).not.toBeNull();
  });

  test("lists only the signed-in wallet's keys", async () => {
    const { controller, store } = setup();
    const alice = Keypair.random().publicKey();
    await store.create(alice);
    await store.create(Keypair.random().publicKey());

    const { keys } = await controller.list(asUser(alice));
    expect(keys).toHaveLength(1);
  });

  test("rotate returns a new raw key once and retires the old one", async () => {
    const { controller, store } = setup();
    const alice = Keypair.random().publicKey();
    const { record } = await store.create(alice);

    const rotated = await controller.rotate(asUser(alice), record.hash);
    expect(rotated.key.startsWith("lw_")).toBe(true);
    expect(record.revokedAt).not.toBeNull();
  });
});

describe("key creation", () => {
  test("returns the raw key and never includes it in a later listing", async () => {
    const { controller } = setup();
    const alice = Keypair.random().publicKey();
    const created = await controller.create(asUser(alice), undefined);
    const listed = await controller.list(asUser(alice));
    expect(JSON.stringify(listed)).not.toContain(created.key);
  });

  test("caps active keys per wallet", async () => {
    const { controller } = setup();
    const alice = Keypair.random().publicKey();
    for (let i = 0; i < 5; i++) await controller.create(asUser(alice), undefined);
    expect(codeOf(await rejection(controller.create(asUser(alice), undefined)))).toBe(
      "key_limit_reached"
    );
  });

  test("revoked keys free a slot", async () => {
    const { controller, store } = setup();
    const alice = Keypair.random().publicKey();
    for (let i = 0; i < 5; i++) await controller.create(asUser(alice), undefined);
    await controller.revoke(asUser(alice), store.records[0].hash);
    await controller.create(asUser(alice), undefined);
    expect(store.records).toHaveLength(6);
  });
});

describe("key label and networks", () => {
  test("stores a trimmed label and the networks in a fixed order, and lists them", async () => {
    const { controller } = setup();
    const alice = Keypair.random().publicKey();
    const created = await controller.create(asUser(alice), {
      label: "  billing worker ",
      networks: ["testnet", "mainnet", "testnet"],
    });
    expect(created.record).toMatchObject({
      label: "billing worker",
      networks: ["mainnet", "testnet"],
      lastUsedAt: null,
    });
    const { keys } = await controller.list(asUser(alice));
    expect(keys[0]).toMatchObject({ label: "billing worker", networks: ["mainnet", "testnet"] });
  });

  test("a key created without them is unlabelled and unscoped", async () => {
    const { controller } = setup();
    const created = await controller.create(asUser(Keypair.random().publicKey()), {});
    expect(created.record).toMatchObject({ label: null, networks: null, lastUsedAt: null });
  });

  test("rotation keeps the label and networks", async () => {
    const { controller } = setup();
    const alice = Keypair.random().publicKey();
    const created = await controller.create(asUser(alice), { label: "ci", networks: ["testnet"] });
    const rotated = await controller.rotate(asUser(alice), created.record.id);
    expect(rotated.record).toMatchObject({ label: "ci", networks: ["testnet"] });
  });

  test.each([
    [""],
    ["   "],
    ["x".repeat(65)],
    ["tab\there"],
    ["bidi\u202eoverride"],
    [42],
    [["a"]],
  ])("refuses the label %p", async (label) => {
    const { controller, store } = setup();
    expect(
      codeOf(await rejection(controller.create(asUser(Keypair.random().publicKey()), { label })))
    ).toBe("invalid_label");
    expect(store.records).toHaveLength(0);
  });

  test("accepts a label of exactly 64 characters, counted as characters", async () => {
    const { controller } = setup();
    const label = "\u00e9".repeat(64);
    const created = await controller.create(asUser(Keypair.random().publicKey()), { label });
    expect(created.record.label).toBe(label);
  });

  test.each([[[]], [["futurenet"]], [["mainnet", 1]], ["testnet"], [{}]])(
    "refuses the networks %p",
    async (networks) => {
      const { controller, store } = setup();
      expect(
        codeOf(
          await rejection(controller.create(asUser(Keypair.random().publicKey()), { networks }))
        )
      ).toBe("invalid_networks");
      expect(store.records).toHaveLength(0);
    }
  );
});

describe("auth endpoints", () => {
  test("challenge rejects a non-account address", () => {
    const { controller } = setup();
    expect(codeOf(catchSync(() => controller.challenge({ address: "CABC" })))).toBe(
      "invalid_address"
    );
  });

  test("session rejects a signature that does not match the challenge", async () => {
    const { controller } = setup();
    const address = Keypair.random().publicKey();
    const { message } = controller.challenge({ address });
    const bad = Buffer.alloc(64).toString("base64");
    expect(codeOf(await rejection(controller.session({ address, message, signature: bad })))).toBe(
      "invalid_challenge"
    );
  });

  test("session issues a token for a correctly signed challenge", async () => {
    const { controller } = setup();
    const kp = Keypair.random();
    const session = await controller.session(signedChallenge(controller, kp));
    expect(session.token.startsWith("lws.")).toBe(true);
  });

  test("a second exchange of the same signed challenge is refused", async () => {
    const { controller } = setup();
    const body = signedChallenge(controller, Keypair.random());
    await controller.session(body);
    const error = await rejection(controller.session(body));
    expect(codeOf(error)).toBe("invalid_challenge");
    expect((error as HttpException).getStatus()).toBe(401);
  });

  test("a concurrent double exchange yields one session", async () => {
    const { controller } = setup();
    const body = signedChallenge(controller, Keypair.random());
    const results = await Promise.allSettled([controller.session(body), controller.session(body)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(codeOf(refused.reason)).toBe("invalid_challenge");
  });

  test("a failed signature does not consume the challenge", async () => {
    const { controller } = setup();
    const owner = Keypair.random();
    const body = signedChallenge(controller, owner);
    const forged = { ...body, signature: sep53(Keypair.random(), body.message) };
    expect(codeOf(await rejection(controller.session(forged)))).toBe("invalid_challenge");
    expect((await controller.session(body)).token.startsWith("lws.")).toBe(true);
  });

  test("the claim names the signed challenge and expires with it", async () => {
    const claims: { challenge: string; expiresAt: Date }[] = [];
    const recording: UsedChallengeStore = {
      claim: async (challenge, expiresAt) => {
        claims.push({ challenge, expiresAt });
        return true;
      },
    };
    const { controller } = setup(undefined, recording);
    const kp = Keypair.random();
    const challenge = controller.challenge({ address: kp.publicKey() });
    await controller.session({
      address: kp.publicKey(),
      message: challenge.message,
      signature: sep53(kp, challenge.message),
    });
    expect(claims).toEqual([
      { challenge: challenge.message, expiresAt: new Date(challenge.expiresAt) },
    ]);
  });

  test("a store that cannot answer gives a 503, never a session", async () => {
    const unavailable: UsedChallengeStore = {
      claim: async () => fail("service_unavailable", "Sign-in is busy.", 503),
    };
    const { controller } = setup(undefined, unavailable);
    const error = await rejection(
      controller.session(signedChallenge(controller, Keypair.random()))
    );
    expect(codeOf(error)).toBe("service_unavailable");
    expect((error as HttpException).getStatus()).toBe(503);
  });

  test("signing in again within the same minute gets a new challenge and a new session", async () => {
    const { controller } = setup();
    const kp = Keypair.random();
    const first = signedChallenge(controller, kp);
    await controller.session(first);
    const second = signedChallenge(controller, kp);
    expect(second.message).not.toBe(first.message);
    expect((await controller.session(second)).token.startsWith("lws.")).toBe(true);
  });

  test("endpoints refuse to run without configuration", () => {
    delete process.env.INTEGRATOR_AUTH_SECRET;
    const { controller } = setup();
    expect(
      codeOf(catchSync(() => controller.challenge({ address: Keypair.random().publicKey() })))
    ).toBe("integrator_api_not_configured");
  });
});

function sep53(kp: Keypair, message: string): string {
  const digest = createHash("sha256").update(`Stellar Signed Message:\n${message}`).digest();
  return Buffer.from(kp.sign(digest)).toString("base64");
}

function signedChallenge(controller: IntegratorController, kp: Keypair) {
  const { message } = controller.challenge({ address: kp.publicKey() });
  return { address: kp.publicKey(), message, signature: sep53(kp, message) };
}

function catchSync(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

describe("IntegratorGuard", () => {
  const guard = new IntegratorGuard();
  const ctx = (authorization?: string, req: Record<string, unknown> = {}) =>
    new ExecutionContextHost([Object.assign(req, { headers: { authorization } })]);

  test("accepts a valid session and exposes its address", () => {
    const address = Keypair.random().publicKey();
    const req: Record<string, unknown> = {};
    expect(guard.canActivate(ctx(`Bearer ${issueSession(SECRET, address).token}`, req))).toBe(true);
    expect(req.integratorAddress).toBe(address);
  });

  test("rejects a missing or forged token", () => {
    expect(codeOf(catchSync(() => guard.canActivate(ctx())))).toBe("unauthorized");
    expect(codeOf(catchSync(() => guard.canActivate(ctx("Bearer lw_apikey"))))).toBe(
      "unauthorized"
    );
  });
});

const contractAddress = (seed: number): string => StrKey.encodeContract(Buffer.alloc(32, seed));

async function signedEntries(
  controller: IntegratorController,
  account: string,
  signer: Keypair
): Promise<string> {
  const challenge = await controller.contractChallenge("testnet", { address: account });
  const [client, server] = xdr.decodeArray(
    xdr.SorobanAuthorizationEntry,
    challenge.authorizationEntries,
    "base64"
  );
  const signed = await authorizeEntry(
    client!,
    signer,
    challenge.validUntilLedger,
    challenge.networkPassphrase
  );
  return xdr.encodeArray(xdr.SorobanAuthorizationEntry, [signed, server!], "base64");
}

describe("contract-account auth endpoints", () => {
  const owner = Keypair.random();
  const account = contractAddress(1);

  test("a contract account signs in and its session manages its own keys on every route", async () => {
    const { controller, store } = setup([fakeProvider([[account, { kind: "ed25519", owner }]])]);
    const authorizationEntries = await signedEntries(controller, account, owner);
    const { token } = await controller.contractSession("testnet", {
      address: account,
      authorizationEntries,
    });

    const guard = new IntegratorGuard();
    const req: Record<string, unknown> = { headers: { authorization: `Bearer ${token}` } };
    expect(guard.canActivate(new ExecutionContextHost([req]))).toBe(true);
    expect(req.integratorAddress).toBe(account);
    const user = asUser(account);

    const created = await controller.create(user, { label: "passkey wallet" });
    expect(store.records[0]!.owner).toBe(account);
    expect((await controller.list(user)).keys.map((k) => k.id)).toEqual([created.record.id]);
    const rotated = await controller.rotate(user, created.record.id);
    expect(rotated.record.id).not.toBe(created.record.id);
    expect(store.records[0]!.revokedAt).not.toBeNull();
    expect(await controller.revoke(user, rotated.record.id)).toEqual({ status: "revoked" });

    const other = await store.create(Keypair.random().publicKey());
    expect(codeOf(await rejection(controller.revoke(user, other.record.hash)))).toBe(
      "api_key_not_found"
    );
    expect(codeOf(await rejection(controller.rotate(user, other.record.hash)))).toBe(
      "api_key_not_found"
    );
  });

  test("a replayed authorization is refused", async () => {
    const { controller } = setup([fakeProvider([[account, { kind: "ed25519", owner }]])]);
    const body = {
      address: account,
      authorizationEntries: await signedEntries(controller, account, owner),
    };
    await controller.contractSession("testnet", body);
    expect(codeOf(await rejection(controller.contractSession("testnet", body)))).toBe(
      "invalid_challenge"
    );
  });

  describe("credential kinds this API does not accept", () => {
    /** A used-challenge store that counts every touch, so a refusal can be shown to leave it alone. */
    class CountingStore extends InMemoryUsedChallengeStore {
      claims = 0;
      override async claim(challenge: string, expiresAt: Date): Promise<boolean> {
        this.claims++;
        return super.claim(challenge, expiresAt);
      }
    }

    const messageOf = (e: unknown): string =>
      (e as HttpException).getResponse() instanceof Object
        ? ((e as HttpException).getResponse() as { error: { message: string } }).error.message
        : "";
    const statusOf = (e: unknown): number => (e as HttpException).getStatus();

    /** One challenge, signed twice: as plain address credentials, and as a delegated-signers
     *  credential whose delegate signs with its own throwaway key. */
    async function bothWays(controller: IntegratorController, who: string, delegate: Keypair) {
      const challenge = await controller.contractChallenge("testnet", { address: who });
      const [client, server] = xdr.decodeArray(
        xdr.SorobanAuthorizationEntry,
        challenge.authorizationEntries,
        "base64"
      );
      const sign = (entry: xdr.SorobanAuthorizationEntry, forAddress?: string) =>
        authorizeEntry(
          entry,
          forAddress ? delegate : owner,
          challenge.validUntilLedger,
          challenge.networkPassphrase,
          forAddress
        );
      const plain = await sign(client!);
      const withDelegates = await sign(
        await sign(
          buildWithDelegatesEntry({
            entry: client!,
            validUntilLedgerSeq: challenge.validUntilLedger,
            delegates: [{ address: delegate.publicKey() }],
          })
        ),
        delegate.publicKey()
      );
      const encode = (entry: xdr.SorobanAuthorizationEntry) =>
        xdr.encodeArray(xdr.SorobanAuthorizationEntry, [entry, server!], "base64");
      return { plain: encode(plain), delegated: encode(withDelegates) };
    }

    test("a delegated credential is refused by name before anything is read, and the challenge stays usable", async () => {
      const provider = fakeProvider([[account, { kind: "ed25519", owner }]]);
      const store = new CountingStore();
      const { controller } = setup([provider], store);
      const entries = await bothWays(controller, account, Keypair.random());

      // Issuing the challenge read the ledger once; the refusal must add nothing to that.
      const readsBefore = provider.ledgerReads;
      const refusal = await rejection(
        controller.contractSession("testnet", {
          address: account,
          authorizationEntries: entries.delegated,
        })
      );
      expect(codeOf(refusal)).toBe("invalid_challenge");
      expect(statusOf(refusal)).toBe(401);
      expect(messageOf(refusal)).toContain("sorobanCredentialsAddressWithDelegates");
      expect(provider.ledgerReads).toBe(readsBefore);
      expect(provider.simulations).toBe(0);
      expect(store.claims).toBe(0);

      const { token } = await controller.contractSession("testnet", {
        address: account,
        authorizationEntries: entries.plain,
      });
      expect(token.startsWith("lws.")).toBe(true);
      expect(store.claims).toBe(1);
    });

    test("the refusal reads the same for every account and every delegate, and echoes none of them", async () => {
      const other = contractAddress(2);
      const { controller } = setup([
        fakeProvider([
          [account, { kind: "ed25519", owner }],
          [other, { kind: "ed25519", owner }],
        ]),
      ]);
      const a = Keypair.random();
      const b = Keypair.random();
      const first = await bothWays(controller, account, a);
      const second = await bothWays(controller, other, b);
      const messages = [
        messageOf(
          await rejection(
            controller.contractSession("testnet", {
              address: account,
              authorizationEntries: first.delegated,
            })
          )
        ),
        messageOf(
          await rejection(
            controller.contractSession("testnet", {
              address: other,
              authorizationEntries: second.delegated,
            })
          )
        ),
      ];
      expect(messages[0]).toBe(messages[1]!);
      for (const echoed of [account, other, a.publicKey(), b.publicKey()]) {
        expect(messages[0]).not.toContain(echoed);
      }
    });

    test("a source-account credential is refused by name too", async () => {
      const { controller } = setup([fakeProvider([[account, { kind: "ed25519", owner }]])]);
      const challenge = await controller.contractChallenge("testnet", { address: account });
      const [client] = xdr.decodeArray(
        xdr.SorobanAuthorizationEntry,
        challenge.authorizationEntries,
        "base64"
      );
      const source = new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
        rootInvocation: client!.rootInvocation,
      });
      const refusal = await rejection(
        controller.contractSession("testnet", {
          address: account,
          authorizationEntries: xdr.encodeArray(xdr.SorobanAuthorizationEntry, [source], "base64"),
        })
      );
      expect(codeOf(refusal)).toBe("invalid_challenge");
      expect(messageOf(refusal)).toContain("sorobanCredentialsSourceAccount");
    });

    test("an input that is not a list of entries keeps the generic refusal", async () => {
      const { controller } = setup([fakeProvider([[account, { kind: "ed25519", owner }]])]);
      for (const authorizationEntries of ["not xdr", "A".repeat(20_000)]) {
        const refusal = await rejection(
          controller.contractSession("testnet", { address: account, authorizationEntries })
        );
        expect(codeOf(refusal)).toBe("invalid_challenge");
        expect(messageOf(refusal)).toBe("The signed challenge is invalid or has expired.");
      }
    });
  });

  test("a forged authorization is refused, and the challenge still works for its owner", async () => {
    const { controller } = setup([fakeProvider([[account, { kind: "ed25519", owner }]])]);
    const challenge = await controller.contractChallenge("testnet", { address: account });
    const signWith = async (signer: Keypair) => {
      const [client, server] = xdr.decodeArray(
        xdr.SorobanAuthorizationEntry,
        challenge.authorizationEntries,
        "base64"
      );
      const signed = await authorizeEntry(
        client!,
        signer,
        challenge.validUntilLedger,
        challenge.networkPassphrase
      );
      return xdr.encodeArray(xdr.SorobanAuthorizationEntry, [signed, server!], "base64");
    };
    const forged = await signWith(Keypair.random());
    expect(
      codeOf(
        await rejection(
          controller.contractSession("testnet", { address: account, authorizationEntries: forged })
        )
      )
    ).toBe("invalid_challenge");
    const session = await controller.contractSession("testnet", {
      address: account,
      authorizationEntries: await signWith(owner),
    });
    expect(session.token.startsWith(`lws.${account}.`)).toBe(true);
  });

  test("a challenge for the other network is refused", async () => {
    process.env.INTEGRATOR_WEB_AUTH_CONTRACT_TESTNET = WEB_AUTH_TESTNET;
    const { controller } = setup([fakeProvider([[account, { kind: "ed25519", owner }]])]);
    const authorizationEntries = await signedEntries(controller, account, owner);
    expect(
      codeOf(
        await rejection(
          controller.contractSession("mainnet", { address: account, authorizationEntries })
        )
      )
    ).toBe("invalid_challenge");
  });

  test("a provider that cannot answer gives a 503, never a session", async () => {
    const down = new FakeWebAuthRpc({
      contractId: WEB_AUTH_TESTNET,
      serverAccount: SERVER.publicKey(),
      networkPassphrase: Networks.TESTNET,
      accounts: new Map(),
      failure: "restore",
    });
    const { controller } = setup([fakeProvider([[account, { kind: "ed25519", owner }]]), down]);
    const challenge = await controller.contractChallenge("testnet", { address: account });
    const [client, server] = xdr.decodeArray(
      xdr.SorobanAuthorizationEntry,
      challenge.authorizationEntries,
      "base64"
    );
    const signed = await authorizeEntry(
      client!,
      owner,
      challenge.validUntilLedger,
      Networks.TESTNET
    );
    const authorizationEntries = xdr.encodeArray(
      xdr.SorobanAuthorizationEntry,
      [signed, server!],
      "base64"
    );
    expect(
      codeOf(
        await rejection(
          controller.contractSession("testnet", { address: account, authorizationEntries })
        )
      )
    ).toBe("service_unavailable");
  });

  test("validates the address and the entries", async () => {
    const { controller } = setup();
    expect(
      codeOf(
        await rejection(
          controller.contractChallenge("testnet", { address: Keypair.random().publicKey() })
        )
      )
    ).toBe("invalid_address");
    expect(
      codeOf(
        await rejection(
          controller.contractSession("testnet", { address: account, authorizationEntries: 1 })
        )
      )
    ).toBe("invalid_request");
  });

  test("answers 503 contract_sign_in_unavailable without a seed, a testnet contract or a ready ledger", async () => {
    delete process.env.INTEGRATOR_WEB_AUTH_CONTRACT_TESTNET;
    expect(
      codeOf(await rejection(setup().controller.contractChallenge("testnet", { address: account })))
    ).toBe("contract_sign_in_unavailable");
    process.env.INTEGRATOR_WEB_AUTH_CONTRACT_TESTNET = WEB_AUTH_TESTNET;
    delete process.env.INTEGRATOR_WEB_AUTH_SIGNING_SEED;
    expect(
      codeOf(await rejection(setup().controller.contractChallenge("mainnet", { address: account })))
    ).toBe("contract_sign_in_unavailable");
    process.env.INTEGRATOR_WEB_AUTH_SIGNING_SEED = SERVER.secret();
    const unfunded = new FakeWebAuthRpc({
      contractId: WEB_AUTH_TESTNET,
      serverAccount: SERVER.publicKey(),
      networkPassphrase: Networks.TESTNET,
      accounts: new Map(),
      serverAccountExists: false,
    });
    expect(
      codeOf(
        await rejection(
          setup([unfunded]).controller.contractChallenge("testnet", { address: account })
        )
      )
    ).toBe("contract_sign_in_unavailable");
  });
});
