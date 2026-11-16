import type { Metadata } from "next";

// The page is a client component and cannot export metadata, so its title is set here, on the
// server, where the root layout's template turns it into "Plan the close | LumenWipe".
export const metadata: Metadata = {
  title: "Plan the close",
};

export default function AnalyzeLayout({ children }: { children: React.ReactNode }) {
  return children;
}
