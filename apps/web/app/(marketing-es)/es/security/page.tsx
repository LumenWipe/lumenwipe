import SecurityPage, { securityMetadata } from "@/components/marketing/SecurityPage";

export const metadata = securityMetadata("es");

export default function SpanishSecurityPage() {
  return <SecurityPage locale="es" />;
}
