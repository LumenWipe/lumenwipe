import type { Metadata } from "next";

// The page is a client component and cannot export metadata, so its title is set here, on the
// server, where the root layout's template turns it into "Token allowances | LumenWipe".
export const metadata: Metadata = {
  title: "Token allowances",
};

export default function AllowancesLayout({ children }: { children: React.ReactNode }) {
  return children;
}
