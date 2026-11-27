/**
 * Signs the exchange registry, or checks the committed signature.
 *
 *   (secret seed on stdin) | bun scripts/sign-registry.ts      sign: reads a Stellar secret seed from stdin
 *   bun scripts/sign-registry.ts --check            verify the committed signature, no secret
 *   bun scripts/sign-registry.ts --check --base REV  also hold it to the registry at REV
 *
 * The seed is read from standard input only and is never taken from an argument, the
 * environment or a file, and never printed. The signing key's public half must be one of the keys
 * pinned in apps/web/lib/exchange-registry/trust-roots.ts. The signature is written beside the
 * registry, `exchange-registry.sig.json`, with a sequence one above the committed one.
 *
 * `--check` fails when the committed signature does not verify under the pinned keys for the
 * committed registry, and, with `--base`, when the registry changed since REV and the sequence did
 * not rise, or the sequence fell.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { canonicalJson } from "../../../apps/web/lib/exchange-registry/canonical";
import {
  parseSignature,
  registryProjection,
  signingBytes,
  verifyRegistrySignature,
  type RegistrySignature,
} from "../../../apps/web/lib/exchange-registry/signature";
import { REGISTRY_SIGNING_KEYS } from "../../../apps/web/lib/exchange-registry/trust-roots";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const REGISTRY_FILE = "apps/api/src/config/exchange-registry.json";
export const SIGNATURE_FILE = "apps/api/src/config/exchange-registry.sig.json";

const SIGN_HINT =
  "Pipe the secret seed into `bun packages/verify/scripts/sign-registry.ts`, then `bun run --filter '@lumenwipe/verify' vectors`.";

function readJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} is not valid JSON.`);
  }
}

function noonOf(day: string): Date {
  return new Date(`${day}T12:00:00Z`);
}

export function signRegistry(input: {
  registryText: string;
  previous: RegistrySignature | null;
  secret: string;
  today: string;
  keys?: readonly string[];
}): RegistrySignature {
  const keys = input.keys ?? REGISTRY_SIGNING_KEYS;
  const secret = input.secret.trim();
  if (!StrKey.isValidEd25519SecretSeed(secret)) {
    throw new Error("The input is not a Stellar secret seed (S...).");
  }
  const signer = Keypair.fromSecret(secret);
  if (!keys.includes(signer.publicKey())) {
    throw new Error(`${signer.publicKey()} is not one of the pinned registry signing keys.`);
  }
  const registry = readJson(input.registryText, "The registry");
  const sequence = (input.previous?.sequence ?? 0) + 1;
  const bytes = signingBytes(registry, { sequence, issuedAt: input.today });
  if (bytes === null) throw new Error("The registry cannot be written as canonical JSON.");
  const envelope: RegistrySignature = {
    format: 1,
    sequence,
    issuedAt: input.today,
    signature: Buffer.from(signer.sign(Buffer.from(bytes))).toString("base64"),
  };
  const verdict = verifyRegistrySignature(registry, envelope, {
    keys,
    bundledSequence: sequence,
    now: noonOf(input.today),
  });
  if (!verdict.ok)
    throw new Error(`The registry cannot be signed as it stands: ${verdict.reason}.`);
  return envelope;
}

export interface BaseState {
  registryText: string | null;
  signatureText: string | null;
}

interface CheckInput {
  registryText: string;
  signatureText: string | null;
  base: BaseState | null;
  keys?: readonly string[];
}

export function checkRegistrySignature(input: CheckInput): string[] {
  try {
    return findProblems(input);
  } catch (error) {
    return [error instanceof Error ? error.message : "The registry signature could not be read."];
  }
}

function findProblems(input: CheckInput): string[] {
  const keys = input.keys ?? REGISTRY_SIGNING_KEYS;
  if (input.signatureText === null) {
    return [`${SIGNATURE_FILE} does not exist. ${SIGN_HINT}`];
  }
  const registry = readJson(input.registryText, REGISTRY_FILE);
  const envelope = parseSignature(readJson(input.signatureText, SIGNATURE_FILE));
  if (envelope === null) return [`${SIGNATURE_FILE} is not a version 1 signature envelope.`];

  const verdict = verifyRegistrySignature(registry, envelope, {
    keys,
    bundledSequence: 0,
    now: noonOf(envelope.issuedAt),
  });
  if (!verdict.ok) {
    return [
      `The signature in ${SIGNATURE_FILE} does not verify under the pinned keys for ${REGISTRY_FILE} (${verdict.reason}). ${SIGN_HINT}`,
    ];
  }
  if (input.base === null) return [];

  const baseEnvelope =
    input.base.signatureText === null
      ? null
      : parseSignature(readJson(input.base.signatureText, "The base signature"));
  const baseSequence = baseEnvelope?.sequence ?? 0;
  const changed =
    input.base.registryText === null ||
    canonicalJson(registryProjection(readJson(input.base.registryText, "The base registry"))) !==
      canonicalJson(registryProjection(registry));
  if (envelope.sequence < baseSequence || (changed && envelope.sequence <= baseSequence)) {
    return [
      changed
        ? `${REGISTRY_FILE} changed but the signature sequence is ${envelope.sequence}, not above ${baseSequence}. ${SIGN_HINT}`
        : `The signature sequence fell from ${baseSequence} to ${envelope.sequence}.`,
    ];
  }
  return [];
}

function git(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return { ok: r.status === 0, out: r.stdout };
}

function baseFile(rev: string, path: string): string | null {
  if (git(["ls-tree", rev, "--", path]).out.trim() === "") return null;
  const shown = git(["show", `${rev}:${path}`]);
  if (!shown.ok) throw new Error(`Cannot read ${path} at ${rev}.`);
  return shown.out;
}

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), "utf8");
  } catch {
    return null;
  }
}

async function main(argv: string[]): Promise<number> {
  const check = argv[0] === "--check";
  const rest = check ? argv.slice(1) : argv;
  const baseRev = rest[0] === "--base" ? rest[1] : undefined;
  const allowed = check ? (baseRev === undefined ? 0 : 2) : 0;
  if (rest.length !== allowed || (check && rest.length > 0 && baseRev === undefined)) {
    console.error(
      "Usage: sign-registry.ts [--check [--base REV]]. The secret seed comes from stdin."
    );
    return 2;
  }
  const registryText = readIfPresent(REGISTRY_FILE);
  if (registryText === null) throw new Error(`${REGISTRY_FILE} is missing.`);
  const signatureText = readIfPresent(SIGNATURE_FILE);

  if (check) {
    let base: BaseState | null = null;
    if (baseRev !== undefined) {
      if (!git(["rev-parse", "--verify", `${baseRev}^{commit}`]).ok) {
        throw new Error(`The base ${baseRev} is not available in this checkout.`);
      }
      base = {
        registryText: baseFile(baseRev, REGISTRY_FILE),
        signatureText: baseFile(baseRev, SIGNATURE_FILE),
      };
    }
    const errors = checkRegistrySignature({ registryText, signatureText, base });
    for (const e of errors) console.error(e);
    if (errors.length === 0) console.log("The exchange registry signature is current.");
    return errors.length === 0 ? 0 : 1;
  }

  if (process.stdin.isTTY) {
    console.error(
      "Pipe the secret seed in on stdin; it is never read from a prompt or an argument."
    );
    return 2;
  }
  const previous =
    signatureText === null ? null : parseSignature(readJson(signatureText, SIGNATURE_FILE));
  if (signatureText !== null && previous === null) {
    throw new Error(`${SIGNATURE_FILE} is not a version 1 signature envelope.`);
  }
  const envelope = signRegistry({
    registryText,
    previous,
    secret: await Bun.stdin.text(),
    today: new Date().toISOString().slice(0, 10),
  });
  writeFileSync(
    fileURLToPath(new URL(`../../../${SIGNATURE_FILE}`, import.meta.url)),
    `${JSON.stringify(envelope, null, 2)}\n`
  );
  console.log(`Signed sequence ${envelope.sequence}, issued ${envelope.issuedAt}.`);
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : "The signing script failed.");
      process.exit(1);
    }
  );
}
