import LandingPage, { landingMetadata } from "@/components/marketing/LandingPage";

export const metadata = landingMetadata("es");

export default function SpanishLandingPage() {
  return <LandingPage locale="es" />;
}
