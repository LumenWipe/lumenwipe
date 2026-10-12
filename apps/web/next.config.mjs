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

export default nextConfig;
