import { expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import { useActiveSigner } from "@/hooks/useActiveSigner";
import { HashXPreimageSigner, SecretKeySigner } from "@/lib/stellar/signer";

function keySigner(): SecretKeySigner {
  return new SecretKeySigner(Keypair.random().secret());
}

test("use-active-signer › state names the signer by kind and key, and never carries it", () => {
  const { result } = renderHook(() => useActiveSigner());
  const signer = keySigner();

  act(() => result.current.select("secret-key", signer));

  expect(result.current.active).toEqual({ kind: "secret-key", id: signer.publicKey });
  expect(Object.values(result.current.active)).not.toContain(signer);
  expect(result.current.current()).toEqual({ kind: "secret-key", signer });
});

test("use-active-signer › clear and endTurn drop the held signer", () => {
  const { result } = renderHook(() => useActiveSigner());

  act(() => result.current.select("secret-key", keySigner()));
  act(() => result.current.clear());
  expect(result.current.current()).toBeNull();
  expect(result.current.active).toEqual({ kind: "none" });

  act(() => result.current.select("secret-key", keySigner()));
  const before = result.current.active;
  act(() => result.current.endTurn());
  expect(result.current.current()).toBeNull();
  expect(result.current.active).toEqual({ kind: "none" });
  expect(result.current.active).not.toBe(before);
});

test("use-active-signer › endTurn gives a fresh none even when none was already shown", () => {
  const { result } = renderHook(() => useActiveSigner());
  const none = result.current.active;
  act(() => result.current.endTurn());
  expect(result.current.active).toEqual({ kind: "none" });
  expect(result.current.active).not.toBe(none);
});

test("use-active-signer › clearKind drops only a signer of that kind", () => {
  const { result } = renderHook(() => useActiveSigner());
  const preimage = new HashXPreimageSigner("X".padEnd(56, "A"), new Uint8Array([1]));

  act(() => result.current.select("hash-x", preimage));
  act(() => result.current.clearKind("secret-key"));
  expect(result.current.current()?.signer).toBe(preimage);
  expect(result.current.active.kind).toBe("hash-x");

  act(() => result.current.select("secret-key", keySigner()));
  act(() => result.current.clearKind("secret-key"));
  expect(result.current.current()).toBeNull();
  expect(result.current.active).toEqual({ kind: "none" });
});

test("use-active-signer › selecting another kind drops the secret-key signer", () => {
  const { result } = renderHook(() => useActiveSigner());
  const key = keySigner();
  const preimage = new HashXPreimageSigner("X".padEnd(56, "A"), new Uint8Array([1]));

  act(() => result.current.select("secret-key", key));
  act(() => result.current.select("hash-x", preimage));
  expect(result.current.current()).toEqual({ kind: "hash-x", signer: preimage });
  expect(result.current.active).toEqual({ kind: "hash-x", id: preimage.publicKey });
});
