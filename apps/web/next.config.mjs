import { PHASE_PRODUCTION_BUILD } from "next/constants.js";
import { APEX_REDIRECT } from "./config/apex-redirect.mjs";
import { SECURITY_HEADERS } from "./config/security-headers.mjs";
import { HOMEPAGE_LINK } from "./config/discovery-links.mjs";
import { appUrlBuildError } from "./config/app-url-build.mjs";
import { walletConnectBuildError } from "./config/wallet-connect-build.mjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Two root layouts, (app) and (marketing), so unmatched URLs need app/global-not-found.tsx.
  experimental: { globalNotFound: true },
  // Consume the workspace SDK/types from their TypeScript source so the web
  // never depends on a pre-built dist (keeps CI/Vercel free of a build-order
  // step). tsconfig `paths` redirect the bare specifiers to source; this
  // transpiles them through the app's compiler.
  transpilePackages: ["@lumenwipe/sdk", "@lumenwipe/types"],
  // The mainnet network used to live at /public (Stellar's network name).
  // It's now /mainnet to match the UI label; keep old links working.
  // `/api/*` included: the proxy skips the CSP there, not these.
  async headers() {
    return [
      { source: "/:path*", headers: [...SECURITY_HEADERS] },
      { source: "/", headers: [{ key: "Link", value: HOMEPAGE_LINK }] },
    ];
  },
  async redirects() {
    return [
      APEX_REDIRECT,
      { source: "/public", destination: "/mainnet", permanent: true },
      { source: "/public/:path*", destination: "/mainnet/:path*", permanent: true },
    ];
  },
};

/**
 * A production deployment fails its build without a WalletConnect project id, instead of
 * shipping with no mobile wallet, or without the site's public origin, instead of shipping
 * canonical URLs and share images that point at another host. Only the build is checked: `next dev` and `next start` load
 * this config in other phases.
 *
 * @param {string} phase
 * @returns {import('next').NextConfig}
 */
export default function config(phase) {
  if (phase === PHASE_PRODUCTION_BUILD) {
    const error = walletConnectBuildError(process.env) ?? appUrlBuildError(process.env);
    if (error) throw new Error(error);
  }
  return nextConfig;
}
