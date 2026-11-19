import SecurityPage, { securityMetadata } from "@/components/marketing/SecurityPage";

export const metadata = securityMetadata("en");

export default function EnglishSecurityPage() {
  return <SecurityPage locale="en" />;
}
