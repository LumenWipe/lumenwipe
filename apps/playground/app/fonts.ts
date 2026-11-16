import localFont from "next/font/local";
import "./fonts/fallback.css";

// Same design-system fonts as apps/web (see apps/web/app/fonts.ts), duplicated
// rather than shared across the app boundary, so the playground reads as the
// same product without apps/playground importing from apps/web. Self-hosted
// from ./fonts, so the build never contacts a font host.

export const fontDisplay = localFont({
  src: "./fonts/bricolage-grotesque-latin-wght.woff2",
  weight: "200 800",
  style: "normal",
  variable: "--font-display",
  display: "swap",
  fallback: ["Bricolage Grotesque Fallback"],
  adjustFontFallback: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
    { prop: "font-stretch", value: "100%" },
  ],
});

export const fontBody = localFont({
  src: "./fonts/manrope-latin-wght.woff2",
  weight: "200 800",
  style: "normal",
  variable: "--font-body",
  display: "swap",
  fallback: ["Manrope Fallback"],
  adjustFontFallback: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
});

export const fontMono = localFont({
  src: "./fonts/jetbrains-mono-latin-wght.woff2",
  weight: "100 800",
  style: "normal",
  variable: "--font-mono",
  display: "swap",
  fallback: ["JetBrains Mono Fallback"],
  adjustFontFallback: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
});

export const siteFontVars = `${fontDisplay.variable} ${fontBody.variable} ${fontMono.variable}`;
