import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { HttpException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { Keypair } from "@stellar/stellar-sdk";
import { ApiKeyDirectory } from "@/auth/api-key-directory";
import { ApiKeyService } from "@/auth/api-key.service";
import type { ApiKeyRecord, ApiKeyStore, NewApiKeyOptions } from "@/auth/api-key-store";
import { AuditLogger } from "@/common/audit-logger";
import { MeteringService } from "@/metering/metering.service";
import { InMemoryUsageStore } from "@/metering/usage-store";
import { IntegratorController } from "@/integrator/integrator.controller";
import { IntegratorGuard, type IntegratorRequest } from "@/integrator/integrator.guard";
import { issueSession } from "@/integrator/wallet-auth";

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

const saved = { secret: process.env.INTEGRATOR_AUTH_SECRET, fs: process.env.FIRESTORE_PROJECT_ID };

beforeEach(() => {
  process.env.INTEGRATOR_AUTH_SECRET = SECRET;
  process.env.FIRESTORE_PROJECT_ID = "test-project";
});

afterEach(() => {
  if (saved.secret === undefined) delete process.env.INTEGRATOR_AUTH_SECRET;
  else process.env.INTEGRATOR_AUTH_SECRET = saved.secret;
  if (saved.fs === undefined) delete process.env.FIRESTORE_PROJECT_ID;
  else process.env.FIRESTORE_PROJECT_ID = saved.fs;
});

function setup() {
  const store = new MemoryStore();
  const directory = new ApiKeyDirectory(
    new ApiKeyService({ get: () => "" } as unknown as ConfigService),
    store
  );
  const controller = new IntegratorController(
    store,
    new MeteringService(new InMemoryUsageStore(), () => new Date()),
    directory,
    new AuditLogger()
  );
  return { store, controller };
}

function asUser(address: string): IntegratorRequest {
  return { integratorAddress: address } as IntegratorRequest;
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

  test("session rejects a signature that does not match the challenge", () => {
    const { controller } = setup();
    const address = Keypair.random().publicKey();
    const { message } = controller.challenge({ address });
    const bad = Buffer.alloc(64).toString("base64");
    expect(codeOf(catchSync(() => controller.session({ address, message, signature: bad })))).toBe(
      "invalid_challenge"
    );
  });

  test("session issues a token for a correctly signed challenge", () => {
    const { controller } = setup();
    const kp = Keypair.random();
    const { message } = controller.challenge({ address: kp.publicKey() });
    const digest = createHash("sha256").update(`Stellar Signed Message:\n${message}`).digest();
    const signature = Buffer.from(kp.sign(digest)).toString("base64");
    const session = controller.session({ address: kp.publicKey(), message, signature });
    expect(session.token.startsWith("lws.")).toBe(true);
  });

  test("endpoints refuse to run without configuration", () => {
    delete process.env.INTEGRATOR_AUTH_SECRET;
    const { controller } = setup();
    expect(
      codeOf(catchSync(() => controller.challenge({ address: Keypair.random().publicKey() })))
    ).toBe("integrator_api_not_configured");
  });
});

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
    ({
      switchToHttp: () => ({
        getRequest: () => Object.assign(req, { headers: { authorization } }),
      }),
    }) as never;

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
