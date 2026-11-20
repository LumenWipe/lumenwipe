import SecurityReportsPage, {
  securityReportsMetadata,
} from "@/components/marketing/SecurityReportsPage";

export const metadata = securityReportsMetadata("en");

export default function EnglishSecurityReportsPage() {
  return <SecurityReportsPage locale="en" />;
}
