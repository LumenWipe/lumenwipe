import type { Metadata } from "next";

// The page is a client component and cannot export metadata, so its title is set here, on the
// server, where the root layout's template turns it into "Cosign a transaction | LumenWipe".
export const metadata: Metadata = {
  title: "Cosign a transaction",
};

export default function CosignLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas">
      <main>{children}</main>
    </div>
  );
}
