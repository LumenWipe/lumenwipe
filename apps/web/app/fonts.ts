import localFont from "next/font/local";
import "./fonts/fallback.css";

// Shared design-system fonts, applied globally so the landing, the app, and
// the blog all read as one product. Self-hosted from ./fonts (see its README
// for the source and version of each file), so the build never contacts a
// font host. Each @font-face keeps the unicode-range Google Fonts gives
// its latin subset (what each file holds), and the fallback faces are in
// ./fonts/fallback.css.

// Display: characterful grotesque for headlines, distinctive, not generic.
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

// Body: clean, legible workhorse with more warmth than Inter.
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

// Mono: engineering authenticity for addresses, amounts, and plan steps.
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
