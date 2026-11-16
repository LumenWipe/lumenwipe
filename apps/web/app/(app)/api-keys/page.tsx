import type { Metadata } from "next";
import { pageMetadata } from "@/lib/site/pages";
import ApiKeysClient from "@/components/api-keys/ApiKeysClient";

export const metadata: Metadata = pageMetadata({
  path: "/api-keys",
  title: "API keys",
  description:
    "Sign in with a Stellar wallet, create a LumenWipe API key in seconds, and revoke it any time. Up to five keys per wallet, each with its own rate limit.",
});

export default function ApiKeysPage() {
  return <ApiKeysClient />;
}
