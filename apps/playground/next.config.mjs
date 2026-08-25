/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Consume the workspace SDK/types from TypeScript source, same reason as apps/web:
  // no build-order dependency on the packages' dist in CI/Vercel/local.
  transpilePackages: ["@lumenwipe/sdk", "@lumenwipe/types"],
  serverExternalPackages: ["sodium-native", "require-addon"],
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        "sodium-native": false,
        "require-addon": false,
      };
    }
    return config;
  },
};

export default nextConfig;
