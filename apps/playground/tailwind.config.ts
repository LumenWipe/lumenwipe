import type { Config } from "tailwindcss";

// Minimal config: apps/playground's v1 UI only uses standard Tailwind
// utilities plus the hand-written .bg-stellar/.text-stellar/.border-stellar
// classes defined directly in globals.css (mirroring apps/web's --stellar
// custom property), so no theme.extend tokens are needed here yet.
const config: Config = {
  content: ["./app/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
