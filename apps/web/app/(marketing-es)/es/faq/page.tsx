import FaqPage, { faqMetadata } from "@/components/marketing/FaqPage";

export const metadata = faqMetadata("es");

export default function SpanishFaqPage() {
  return <FaqPage locale="es" />;
}
