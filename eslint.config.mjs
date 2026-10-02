import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "test/fixtures/repo-facts/**", "test/fixtures/**/tree/**", "test/fixtures/workers/**", "examples/*/app/**"],
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly" },
    },
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);