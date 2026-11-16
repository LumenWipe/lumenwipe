import type { Metadata } from "next";

// The page is a client component and cannot export metadata, so its title is set here, on the
// server, where the root layout's template turns it into "Review the plan | LumenWipe".
export const metadata: Metadata = {
  title: "Review the plan",
};

export default function ReviewLayout({ children }: { children: React.ReactNode }) {
  return children;
}
