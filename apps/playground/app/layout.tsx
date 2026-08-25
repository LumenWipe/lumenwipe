import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { siteFontVars } from "./fonts";
import PlaygroundNav from "@/components/PlaygroundNav";
import PlaygroundFooter from "@/components/PlaygroundFooter";

export const metadata: Metadata = {
  title: "LumenWipe Playground",
  description: "Watch a demo Stellar account get messed up, then closed, live on testnet.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        {process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID && (
          <script
            defer
            src="https://cloud.umami.is/script.js"
            data-website-id={process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID}
          />
        )}
      </head>
      <body className={`${siteFontVars} font-body`}>
        <div className="mkt relative min-h-screen overflow-x-clip bg-[hsl(var(--mkt-bg))]">
          <div aria-hidden className="pointer-events-none absolute inset-0 z-0">
            <div className="absolute inset-0 mkt-grain" />
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-stellar/30 to-transparent" />
          </div>
          <div className="relative z-10 flex min-h-screen flex-col">
            <PlaygroundNav />
            <main className="flex-1">{children}</main>
            <PlaygroundFooter />
          </div>
        </div>
      </body>
    </html>
  );
}
