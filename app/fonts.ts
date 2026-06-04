import { Bricolage_Grotesque, Manrope, JetBrains_Mono } from "next/font/google";

// Shared design-system fonts, applied globally so the landing, the app, and
// the blog all read as one product.

// Display: characterful grotesque for headlines, distinctive, not generic.
export const fontDisplay = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

// Body: clean, legible workhorse with more warmth than Inter.
export const fontBody = Manrope({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

// Mono: engineering authenticity for addresses, amounts, and plan steps.
export const fontMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const siteFontVars = `${fontDisplay.variable} ${fontBody.variable} ${fontMono.variable}`;
