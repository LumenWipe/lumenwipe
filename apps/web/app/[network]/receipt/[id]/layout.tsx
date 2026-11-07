import type { Metadata } from "next";

// A receipt exists only in the browser that saved it: nothing here is for a search engine.
export const metadata: Metadata = {
  title: "Receipt",
  robots: { index: false, follow: false },
};

export default function ReceiptLayout({ children }: { children: React.ReactNode }) {
  return children;
}
