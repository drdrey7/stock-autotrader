import { test, expect } from "@playwright/test";

const routes = [
  { path: "/", label: "Morning Briefing" },
  { path: "/x", label: "X Pulse" },
  { path: "/earnings", label: "Earnings" },
];

for (const route of routes) {
  test(`${route.label} renders without a fatal shell error`, async ({ page }) => {
    const response = await page.goto(route.path, { waitUntil: "domcontentloaded" });
    expect(response?.ok()).toBeTruthy();

    await expect(page.getByText("Morning Briefing", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary navigation" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: route.label }).first()).toHaveAttribute("aria-current", "page");
    await expect(page.locator("body")).not.toContainText("Page unavailable");
  });
}

test("primary navigation works without a full-page reload", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await page.getByRole("button", { name: "X Pulse" }).first().click();
  await expect(page).toHaveURL(/\/x$/);
  await expect(page.getByRole("button", { name: "X Pulse" }).first()).toHaveAttribute("aria-current", "page");

  await page.getByRole("button", { name: "Earnings" }).first().click();
  await expect(page).toHaveURL(/\/earnings$/);
  await expect(page.getByRole("button", { name: "Earnings" }).first()).toHaveAttribute("aria-current", "page");
});
