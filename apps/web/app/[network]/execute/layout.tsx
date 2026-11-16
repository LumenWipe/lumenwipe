import type { Metadata } from "next";

// The page is a client component and cannot export metadata, so its title is set here, on the
// server, where the root layout's template turns it into "Sign the close | LumenWipe".
export const metadata: Metadata = {
  title: "Sign the close",
};

export default function ExecuteLayout({ children }: { children: React.ReactNode }) {
  return children;
}
