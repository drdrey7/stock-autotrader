import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const briefingSource = readFileSync(new URL("../morning-briefing/MorningBriefingApp.tsx", import.meta.url), "utf8");
const shellSource = readFileSync(new URL("../shell/AppShell.tsx", import.meta.url), "utf8");
const stockSource = readFileSync(new URL("../morning-briefing/stock-detail/StockDetailPage.tsx", import.meta.url), "utf8");

describe("CSS runtime boundaries", () => {
  it("keeps the entrypoint foundation-only", () => {
    expect(mainSource).toContain('import "./branding/tokens.css"');
    expect(mainSource).toContain('import "./styles/base.css"');
    expect(mainSource).not.toContain("morning-briefing.css");
    expect(mainSource).not.toContain("typography.css");
    expect(mainSource).not.toContain('import "./styles.css"');
    expect(mainSource).not.toContain('import "./daily-briefing.css"');
  });

  it("loads route typography from the component that owns the route", () => {
    expect(briefingSource).toContain('import "./morning-briefing.css"');
    expect(briefingSource).toContain('import "./typography.css"');
    expect(shellSource).toContain('import "./shell.css"');
    expect(shellSource).toContain('import "./typography.css"');
    expect(stockSource).toContain('import "./stock-detail.css"');
    expect(stockSource).toContain('import "./typography.css"');
  });

  it("does not keep retired global CSS generations in src", () => {
    expect(existsSync(new URL("../styles.css", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../daily-briefing.css", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../typography.css", import.meta.url))).toBe(false);
  });

  it("routes active information pages through their dedicated owner", () => {
    expect(appSource).toContain('from "./information-pages"');
    expect(appSource).not.toContain('from "./daily-briefing-pages"');
  });
});
