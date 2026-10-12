import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";

const RELATIVE_FETCH = [
  {
    selector: "CallExpression[callee.name='fetch'][arguments.0.value=/^\\//]",
    message:
      "A relative URL throws Invalid URL in Node. Pass an absolute URL to fetch in apps/api.",
  },
  {
    selector:
      "CallExpression[callee.name='fetch'][arguments.0.type='TemplateLiteral'][arguments.0.quasis.0.value.raw=/^\\//]",
    message:
      "A relative URL throws Invalid URL in Node. Pass an absolute URL to fetch in apps/api.",
  },
];

export default [
  { ignores: ["dist", "node_modules"] },
  js.configs.recommended,
  ...tsPlugin.configs["flat/recommended"],
  {
    files: ["**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@lumenwipe/playground",
                "@lumenwipe/playground/*",
                "@lumenwipe/web",
                "@lumenwipe/web/*",
              ],
              message: "apps/api must not import apps/playground or apps/web directly.",
            },
          ],
        },
      ],
      "no-restricted-syntax": ["error", ...RELATIVE_FETCH],
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...RELATIVE_FETCH,
        {
          selector: "CallExpression[callee.object.name='mock'][callee.property.name='module']",
          message:
            "mock.module replaces a module for the whole `bun test` process and leaks into other test files depending on file order (it turned CI red on 2026-09-02). Patch the real module object with spyOn(...).mockImplementation(...) and undo it with mock.restore() in afterEach, or inject the dependency.",
        },
      ],
    },
  },
];
