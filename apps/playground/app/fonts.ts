import { Bricolage_Grotesque, Manrope, JetBrains_Mono } from "next/font/google";

// Same design-system fonts as apps/web (see apps/web/app/fonts.ts), duplicated
// rather than shared across the app boundary, so the playground reads as the
// same product without apps/playground importing from apps/web.

export const fontDisplay = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

export const fontBody = Manrope({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

export const fontMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const siteFontVars = `${fontDisplay.variable} ${fontBody.variable} ${fontMono.variable}`;
