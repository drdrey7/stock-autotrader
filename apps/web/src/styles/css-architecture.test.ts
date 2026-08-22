import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

describe("CSS runtime boundaries", () => {
  it("loads the shared foundation without restoring legacy global stylesheets", () => {
    expect(mainSource).toContain('import "./styles/base.css"');
    expect(mainSource).not.toContain('import "./styles.css"');
    expect(mainSource).not.toContain('import "./daily-briefing.css"');
  });

  it("routes active information pages through their dedicated owner", () => {
    expect(appSource).toContain('from "./information-pages"');
    expect(appSource).not.toContain('from "./daily-briefing-pages"');
  });
});
