import type { Config } from "tailwindcss";

// Minimal config: apps/playground's UI only uses standard Tailwind utilities
// plus the hand-written .bg-stellar/.text-stellar/.border-stellar/.mkt-* classes
// defined directly in globals.css (mirroring apps/web's design tokens), so no
// theme.extend tokens are needed here yet.
const config: Config = {
  content: ["./app/**/*.{js,ts,jsx,tsx,mdx}", "./components/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
