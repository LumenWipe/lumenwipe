import type { Metadata } from "next";
import ApiKeysClient from "@/components/api-keys/ApiKeysClient";

export const metadata: Metadata = {
  title: "API keys · LumenWipe",
  description:
    "Sign in with Google or GitHub, create a LumenWipe API key in seconds, and revoke it any time. No waiting on the team.",
};

export default function ApiKeysPage() {
  return <ApiKeysClient />;
}
