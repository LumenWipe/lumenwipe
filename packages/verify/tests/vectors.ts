/** Typed access to the committed vector file, shared by the package tests. */
import { readFileSync } from "node:fs";
import { VECTORS_PATH, type VectorFile } from "../scripts/generate-vectors";

export const VECTOR_FILE_TEXT = readFileSync(VECTORS_PATH, "utf8");
export const VECTOR_FILE = JSON.parse(VECTOR_FILE_TEXT) as VectorFile;
