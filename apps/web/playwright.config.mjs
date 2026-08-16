import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  retries: 1,
  workers: 2,
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  webServer: {
    // `vite preview` ignores Cloudflare `_headers`, so the E2E suite runs
    // against scripts/preview-server.mjs, which serves the built dist/ with
    // the exact production Content-Security-Policy and security headers.
    command: "npm run build && node scripts/preview-server.mjs 4173",
    port: 4173,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
});
