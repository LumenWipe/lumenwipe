import { PHASE_PRODUCTION_BUILD } from "next/constants.js";
import { walletConnectBuildError } from "./config/wallet-connect-build.mjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Consume the workspace SDK/types from their TypeScript source so the web
  // never depends on a pre-built dist (keeps CI/Vercel free of a build-order
  // step). tsconfig `paths` redirect the bare specifiers to source; this
  // transpiles them through the app's compiler.
  transpilePackages: ["@lumenwipe/sdk", "@lumenwipe/types"],
  // The mainnet network used to live at /public (Stellar's network name).
  // It's now /mainnet to match the UI label; keep old links working.
  async redirects() {
    return [
      { source: "/public", destination: "/mainnet", permanent: true },
      { source: "/public/:path*", destination: "/mainnet/:path*", permanent: true },
    ];
  },
};

/**
 * A production deployment fails its build without a WalletConnect project id, instead of
 * shipping with no mobile wallet. Only the build is checked: `next dev` and `next start` load
 * this config in other phases.
 *
 * @param {string} phase
 * @returns {import('next').NextConfig}
 */
export default function config(phase) {
  if (phase === PHASE_PRODUCTION_BUILD) {
    const error = walletConnectBuildError(process.env);
    if (error) throw new Error(error);
  }
  return nextConfig;
}
