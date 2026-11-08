import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import globals from "globals";

const config = [
  { ignores: ["node_modules/**"] },
  js.configs.recommended,
  ...tsPlugin.configs["flat/recommended"],
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
];

export default config;
