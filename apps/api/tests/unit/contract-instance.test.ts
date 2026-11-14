import { describe, expect, test } from "bun:test";
import { Address, Keypair, xdr } from "@stellar/stellar-sdk";
import {
  codeRefOf,
  readLiveCodeIdentity,
  resolveCodeRefs,
  type LedgerBatchReader,
} from "@/lib/stellar/contract-instance";
import { instanceOfEntry } from "@/lib/stellar/contract-data";
import {
  contractInstanceEntry,
  executableTagEntry,
  externalRefInstanceEntry,
  mockRpc,
} from "./fixtures/testnet-direct-read-helpers";

const POOL = "CDLYWB5CCSNOEXPGHSKYO4FW3R4XFQVI2HR2QC735YDVCSEQJABQDFXI";
const OWNER = "CDD3G6M2JSJLXBYLY4N6WLWVU2LB5UGPSKFO5ZV4M6BMYQY555Q6FA46";
const HASH = "70476939e1ce8b4f7d6898d7a1403bd0752ba0535ad6c4aea3c4b500ad4715e0";
const OTHER_HASH = "7".repeat(64);

type Entry = ReturnType<typeof contractInstanceEntry>;

/** A batch reader over fixed entries that records every call's keys. */
function tracingReader(entries: Entry[]): LedgerBatchReader & { calls: string[][] } {
  const calls: string[][] = [];
  const reader = async (keys: xdr.LedgerKey[]) => {
    calls.push(keys.map((k) => k.toXdr("base64")));
    const wanted = new Set(keys.map((k) => k.toXdr("base64")));
    return new Map(
      entries
        .filter((e) => wanted.has(e.key.toXdr("base64")))
        .map((e) => [e.key.toXdr("base64"), e.val] as const)
    );
  };
  return Object.assign(reader, { calls });
}

function instanceWithExecutable(executable: xdr.ContractExecutable): xdr.ScContractInstance {
  return new xdr.ScContractInstance({ executable, storage: null });
}

describe("codeRefOf", () => {
  test("a Wasm instance carries its own hash", () => {
    const ref = codeRefOf(instanceOfEntry(contractInstanceEntry(POOL, HASH).val));
    expect(ref).toEqual({ kind: "wasm", wasmHash: HASH });
  });

  test("an external reference names its owner and tag, not a hash", () => {
    const ref = codeRefOf(
      instanceOfEntry(externalRefInstanceEntry(POOL, OWNER, "amm.constant").val)
    );
    expect(ref).toEqual({ kind: "external-ref", owner: OWNER, tag: "amm.constant" });
  });

  test("a Stellar Asset Contract has no code of its own", () => {
    expect(
      codeRefOf(instanceWithExecutable(xdr.ContractExecutable.contractExecutableStellarAsset()))
    ).toBeNull();
  });

  test("an owner that is not a contract cannot hold a tag entry, so the reference is unresolvable", () => {
    const account = Keypair.random().publicKey();
    const executable = xdr.ContractExecutable.contractExecutableExternalRef(
      new xdr.ContractExecutableExternalRef({
        executableOwner: new Address(account).toScAddress(),
        tag: "amm.constant",
      })
    );
    expect(codeRefOf(instanceWithExecutable(executable))).toBeNull();
  });

  test("a tag that is not valid UTF-8 is unresolvable rather than read leniently", () => {
    const executable = xdr.ContractExecutable.contractExecutableExternalRef(
      new xdr.ContractExecutableExternalRef({
        executableOwner: new Address(OWNER).toScAddress(),
        tag: new Uint8Array([0xff, 0xfe]),
      })
    );
    expect(codeRefOf(instanceWithExecutable(executable))).toBeNull();
  });
});

describe("resolveCodeRefs", () => {
  const ref = { kind: "external-ref", owner: OWNER, tag: "amm.constant" } as const;

  test("follows a reference to the hash its owner's tag entry holds", async () => {
    const read = tracingReader([executableTagEntry(OWNER, "amm.constant", HASH)]);
    expect(await resolveCodeRefs(read, [ref])).toEqual([{ ...ref, wasmHash: HASH }]);
  });

  test("deduplicates owner/tag pairs into one batched read and makes none for Wasm alone", async () => {
    const read = tracingReader([
      executableTagEntry(OWNER, "amm.constant", HASH),
      executableTagEntry(OWNER, "amm.stable", OTHER_HASH),
    ]);
    const stable = { ...ref, tag: "amm.stable" };
    const wasm = { kind: "wasm", wasmHash: HASH } as const;
    const out = await resolveCodeRefs(read, [ref, wasm, stable, ref, null]);
    expect(out).toEqual([
      { ...ref, wasmHash: HASH },
      wasm,
      { ...stable, wasmHash: OTHER_HASH },
      { ...ref, wasmHash: HASH },
      null,
    ]);
    expect(read.calls.map((c) => c.length)).toEqual([2]);

    const wasmOnly = tracingReader([]);
    expect(await resolveCodeRefs(wasmOnly, [wasm, null])).toEqual([wasm, null]);
    expect(wasmOnly.calls).toEqual([]);
  });

  test("a tag entry the ledger does not return leaves the reference unresolved, as a missing instance does", async () => {
    // An entry evicted to the archive is not returned by getLedgerEntries; the instance readers
    // take that absence as "no code", and so does this one.
    expect(await resolveCodeRefs(tracingReader([]), [ref])).toEqual([null]);
  });

  test("a tag entry that does not hold exactly 32 bytes is unresolvable", async () => {
    const short = tracingReader([
      executableTagEntry(OWNER, "amm.constant", xdr.ScVal.scvBytes(Buffer.alloc(31, 1))),
    ]);
    expect(await resolveCodeRefs(short, [ref])).toEqual([null]);
    const notBytes = tracingReader([
      executableTagEntry(OWNER, "amm.constant", xdr.ScVal.scvSymbol("amm")),
    ]);
    expect(await resolveCodeRefs(notBytes, [ref])).toEqual([null]);
  });

  test("nothing is cached: a repointed tag is seen on the very next resolution", async () => {
    const entries = [executableTagEntry(OWNER, "amm.constant", HASH)];
    const read = tracingReader(entries);
    expect((await resolveCodeRefs(read, [ref]))[0]?.wasmHash).toBe(HASH);
    entries[0] = executableTagEntry(OWNER, "amm.constant", OTHER_HASH);
    expect((await resolveCodeRefs(read, [ref]))[0]?.wasmHash).toBe(OTHER_HASH);
    expect(read.calls).toHaveLength(2);
  });
});

describe("readLiveCodeIdentity", () => {
  test("a Wasm contract costs one read", async () => {
    const rpc = mockRpc([contractInstanceEntry(POOL, HASH)]);
    expect(await readLiveCodeIdentity(rpc, POOL)).toEqual({ kind: "wasm", wasmHash: HASH });
  });

  test("an external reference is followed to its owner's tag", async () => {
    const rpc = mockRpc([
      externalRefInstanceEntry(POOL, OWNER, "amm.constant"),
      executableTagEntry(OWNER, "amm.constant", HASH),
    ]);
    expect(await readLiveCodeIdentity(rpc, POOL)).toEqual({
      kind: "external-ref",
      owner: OWNER,
      tag: "amm.constant",
      wasmHash: HASH,
    });
  });

  test("an absent contract, or a reference whose tag entry is missing, has no code", async () => {
    expect(await readLiveCodeIdentity(mockRpc([]), POOL)).toBeNull();
    const rpc = mockRpc([externalRefInstanceEntry(POOL, OWNER, "amm.constant")]);
    expect(await readLiveCodeIdentity(rpc, POOL)).toBeNull();
  });
});
