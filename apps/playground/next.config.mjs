/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Consume the workspace SDK/types from TypeScript source, same reason as apps/web:
  // no build-order dependency on the packages' dist in CI/Vercel/local.
  transpilePackages: ["@lumenwipe/sdk", "@lumenwipe/types"],
};

export default nextConfig;
