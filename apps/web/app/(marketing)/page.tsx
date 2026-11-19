import LandingPage, { landingMetadata } from "@/components/marketing/LandingPage";

export const metadata = landingMetadata("en");

export default function EnglishLandingPage() {
  return <LandingPage locale="en" />;
}
