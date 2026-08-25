import type { Config } from "tailwindcss";

// apps/playground's UI mostly uses standard Tailwind utilities plus the
// hand-written .bg-stellar/.text-stellar/.border-stellar/.mkt-* classes
// defined directly in globals.css (mirroring apps/web's design tokens).
// The `value`/`destructive` colors below ARE registered as Tailwind theme
// tokens (not hand-written flat classes) because ported components rely on
// Tailwind's opacity-modifier syntax (border-value/30, bg-destructive/10),
// which only resolves for real theme colors using the CSS-var-in-HSL pattern.
const config: Config = {
  content: ["./app/**/*.{js,ts,jsx,tsx,mdx}", "./components/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        display: ["var(--font-display)", "ui-sans-serif", "system-ui", "sans-serif"],
        body: ["var(--font-body)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      colors: {
        value: {
          DEFAULT: "hsl(var(--value))",
          foreground: "hsl(var(--value-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
      },
    },
  },
  plugins: [],
};

export default config;
