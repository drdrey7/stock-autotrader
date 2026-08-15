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
    exclude: [...configDefaults.exclude, "e2e/**"],
    coverage: {
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
});
