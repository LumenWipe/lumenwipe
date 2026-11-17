import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import globals from "globals";

// A cast through unknown hides where a test double stops matching the type it stands in for.
const DOUBLE_CAST = {
  selector:
    ":matches(TSAsExpression, TSTypeAssertion) > :matches(TSAsExpression, TSTypeAssertion).expression[typeAnnotation.type='TSUnknownKeyword']",
  message:
    "Do not cast through unknown in tests: build the real type with a typed builder so a drifted fixture fails type-check.",
};

const config = [
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tsPlugin.configs["flat/recommended"],
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  { files: ["tests/**/*.ts"], rules: { "no-restricted-syntax": ["error", DOUBLE_CAST] } },
];

export default config;
