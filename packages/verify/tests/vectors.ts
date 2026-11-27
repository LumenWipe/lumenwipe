/** Typed access to the committed vector file, shared by the package tests. */
import { readFileSync } from "node:fs";
import { VECTORS_PATH, type VectorFile } from "../scripts/generate-vectors";
import {
  REGISTRY_SIGNING_VECTORS_PATH,
  type RegistrySigningVectorFile,
} from "../scripts/registry-signing-vectors";
import { REVOKE_VECTORS_PATH, type RevokeVectorFile } from "../scripts/revoke-vectors";

export const VECTOR_FILE_TEXT = readFileSync(VECTORS_PATH, "utf8");
export const VECTOR_FILE = JSON.parse(VECTOR_FILE_TEXT) as VectorFile;

export const REVOKE_VECTOR_FILE_TEXT = readFileSync(REVOKE_VECTORS_PATH, "utf8");
export const REVOKE_VECTOR_FILE = JSON.parse(REVOKE_VECTOR_FILE_TEXT) as RevokeVectorFile;

export const REGISTRY_SIGNING_VECTOR_FILE_TEXT = readFileSync(
  REGISTRY_SIGNING_VECTORS_PATH,
  "utf8"
);
export const REGISTRY_SIGNING_VECTOR_FILE = JSON.parse(
  REGISTRY_SIGNING_VECTOR_FILE_TEXT
) as RegistrySigningVectorFile;
