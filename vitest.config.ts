import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vendored repo-facts fixture trees contain their own test files as data.
    exclude: [...configDefaults.exclude, "test/fixtures/**"],
    // Provider workers run compiled modules.
    globalSetup: ["test/support/global-setup.ts"],
  },
});
