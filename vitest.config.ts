import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "node",
    // Builds dist once for the CLI tests; see test/global-setup.ts.
    globalSetup: ["test/global-setup.ts"],
  },
})
