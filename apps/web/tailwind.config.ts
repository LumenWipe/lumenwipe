import type { Config } from "tailwindcss";
// Imported, not require()d. This file uses `export default`, so Node loads it as ESM and
// `require` is undefined there - the dev server started fine and then died with
// "ReferenceError: require is not defined" the first time PostCSS asked Tailwind for its
// config, i.e. on the first page that has styles. It survived only when Next happened to be
// launched through Bun, which made the failure look intermittent and environment-specific.
import typography from "@tailwindcss/typography";

const token = (name: string): string => `hsl(var(--${name}) / <alpha-value>)`;

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
        value: { DEFAULT: token("value"), fg: token("value-fg") },
        canvas: token("bg"),
        surface: {
          DEFAULT: token("surface"),
          raised: token("surface-raised"),
          sunken: token("surface-sunken"),
        },
        line: { DEFAULT: token("line"), strong: token("line-strong") },
        edge: token("edge"),
        fg: {
          DEFAULT: token("fg"),
          muted: token("fg-muted"),
          subtle: token("fg-subtle"),
          disabled: token("fg-disabled"),
        },
        success: token("success"),
        danger: {
          DEFAULT: token("danger"),
          fg: token("danger-fg"),
          "on-fill": token("danger-on-fill"),
        },
        focus: token("focus"),
        warning: { DEFAULT: token("warning"), fg: token("warning-fg") },
        accent: { DEFAULT: token("accent"), fg: token("accent-fg") },
      },
      opacity: { "6": "0.06", "8": "0.08", "12": "0.12" },
      spacing: {
        gutter: "var(--space-4)",
        card: "var(--space-5)",
        control: "var(--space-control)",
      },
      fontSize: {
        caption: ["var(--text-caption)", { lineHeight: "1rem" }],
        label: ["var(--text-label)", { lineHeight: "1rem" }],
        "body-sm": ["var(--text-body-sm)", { lineHeight: "1.25rem" }],
        body: ["var(--text-body)", { lineHeight: "1.5rem" }],
        title: ["var(--text-title)", { lineHeight: "1.75rem" }],
        heading: ["var(--text-heading)", { lineHeight: "2.25rem" }],
        display: ["var(--text-display)", { lineHeight: "2.75rem" }],
        hero: ["var(--text-hero)", { lineHeight: "1" }],
      },
      transitionDuration: {
        fast: "var(--duration-fast)",
        base: "var(--duration-base)",
        slow: "var(--duration-slow)",
      },
      transitionTimingFunction: { standard: "var(--ease-standard)" },
      borderRadius: {
        badge: "var(--radius-sm)",
        control: "var(--radius-md)",
        card: "var(--radius-lg)",
        dialog: "var(--radius-xl)",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [typography],
};

export default config;
