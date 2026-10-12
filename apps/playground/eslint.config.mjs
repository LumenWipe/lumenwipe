import coreWebVitals from "eslint-config-next/core-web-vitals";
import prettier from "eslint-config-prettier";

const config = [
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
  ...coreWebVitals,
  prettier,
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/lib/stellar/tx-builder",
                "@/lib/stellar/tx-builder/*",
                "@/lib/close-api",
                "@/lib/close-api/*",
              ],
              message:
                "apps/playground never re-implements closing logic. Mess-building lives in ./lib directly; closing goes through @lumenwipe/sdk's runClose against the real API.",
            },
            {
              group: ["@lumenwipe/api", "@lumenwipe/api/*", "@lumenwipe/web", "@lumenwipe/web/*"],
              message: "apps/playground must not import apps/api or apps/web directly.",
            },
          ],
        },
      ],
    },
  },
];

export default config;
