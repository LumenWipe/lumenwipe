import type { ReactNode } from "react";
import MarketingShell from "@/components/marketing/MarketingShell";

/** A sign-in route, so it renders under the nonce policy, in the marketing site's frame. */
export default function ApiKeysLayout({ children }: { children: ReactNode }) {
  return <MarketingShell>{children}</MarketingShell>;
}
