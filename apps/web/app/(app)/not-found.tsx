import MarketingShell from "@/components/marketing/MarketingShell";
import NotFoundView, { NOT_FOUND_METADATA } from "@/components/marketing/NotFoundView";

export const metadata = NOT_FOUND_METADATA;

export default function NotFound() {
  return (
    <MarketingShell>
      <NotFoundView />
    </MarketingShell>
  );
}
