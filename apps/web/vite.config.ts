import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  preview: { port: 4173 },
  build: { sourcemap: true },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test-setup.ts",
    // No process-level TZ pin: the local-time hero greeting/date helpers are
    // tested as pure functions with explicit Date instances, so the suite must
    // pass in any machine timezone (Linux, macOS, Windows) as-is.
    exclude: [...configDefaults.exclude, "e2e/**"],
    coverage: {
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/test-setup.ts"],
      thresholds: {
        lines: 45,
        functions: 45,
        branches: 45,
        statements: 45,
      },
    },
  },
});
