import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(process.cwd(), "src");
const readSource = (path: string) => readFileSync(resolve(sourceRoot, path), "utf8");

const mainSource = readSource("main.tsx");
const appSource = readSource("App.tsx");
const briefingSource = readSource("morning-briefing/MorningBriefingApp.tsx");
const shellSource = readSource("shell/AppShell.tsx");
const stockSource = readSource("morning-briefing/stock-detail/StockDetailPage.tsx");
const informationSource = readSource("information/InformationPages.tsx");

describe("CSS runtime boundaries", () => {
  it("keeps the entrypoint foundation-only", () => {
    expect(mainSource).toContain('import "./branding/tokens.css"');
    expect(mainSource).toContain('import "./styles/base.css"');
    const cssImports = mainSource.match(/import\s+["'][^"']+\.css["'];?/g) ?? [];
    expect(cssImports).toHaveLength(2);
    expect(mainSource).not.toContain("morning-briefing.css");
    expect(mainSource).not.toContain("typography.css");
    expect(mainSource).not.toContain('import "./styles.css"');
    expect(mainSource).not.toContain('import "./daily-briefing.css"');
  });

  it("loads route styles from the component that owns the route", () => {
    expect(briefingSource).toContain('import "./morning-briefing.css"');
    expect(briefingSource).toContain('import "./typography.css"');
    expect(shellSource).toContain('import "./shell.css"');
    expect(shellSource).toContain('import "./typography.css"');
    expect(stockSource).toContain('import "./stock-detail.css"');
    expect(stockSource).toContain('import "./typography.css"');
    expect(informationSource).toContain('import "./information.css"');
  });

  it("does not keep retired global CSS generations in src", () => {
    expect(existsSync(resolve(sourceRoot, "styles.css"))).toBe(false);
    expect(existsSync(resolve(sourceRoot, "daily-briefing.css"))).toBe(false);
    expect(existsSync(resolve(sourceRoot, "typography.css"))).toBe(false);
  });

  it("routes active information pages through their dedicated owner", () => {
    expect(appSource).toContain('from "./information/InformationPages"');
    expect(appSource).not.toContain('from "./daily-briefing-pages"');
  });
});
