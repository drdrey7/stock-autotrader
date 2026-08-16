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
    // Pin the process timezone so the local-time hero greeting/date tests are
    // deterministic on every machine (CI runners and local dev alike).
    env: { TZ: "UTC" },
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
