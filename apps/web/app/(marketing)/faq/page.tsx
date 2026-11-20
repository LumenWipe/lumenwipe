import FaqPage, { faqMetadata } from "@/components/marketing/FaqPage";

export const metadata = faqMetadata("en");

export default function EnglishFaqPage() {
  return <FaqPage locale="en" />;
}
