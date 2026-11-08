import { defineConfig } from "tsup";

// The entry imports four modules from apps/web by relative path. Their own `@/` and
// `@registry/` imports resolve through the nearest tsconfig, apps/web's, so the bundle carries
// exactly the code the web signs with. `@stellar/stellar-sdk` is a peer and stays external
// (tsup externalises peerDependencies); the bundle test fails if it is ever inlined.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  target: "es2022",
  platform: "neutral",
  clean: true,
  treeshake: true,
  outDir: "dist",
});
