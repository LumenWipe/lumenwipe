import SecurityReportsPage, {
  securityReportsMetadata,
} from "@/components/marketing/SecurityReportsPage";

export const metadata = securityReportsMetadata("es");

export default function SpanishSecurityReportsPage() {
  return <SecurityReportsPage locale="es" />;
}
