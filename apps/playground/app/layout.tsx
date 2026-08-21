import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "LumenWipe Playground",
  description: "Watch a demo Stellar account get messed up, then closed, live on testnet.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
