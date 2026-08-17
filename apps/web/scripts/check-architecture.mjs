import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(webRoot, "src");
const errors = [];

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

const sourceFiles = walk(srcRoot)
  .filter((file) => /\.(ts|tsx)$/.test(file))
  .filter((file) => !/\.test\.(ts|tsx)$/.test(file))
  .filter((file) => !file.endsWith("test-setup.ts"));

const relative = (file) => path.relative(srcRoot, file).split(path.sep).join("/");
const read = (file) => fs.readFileSync(file, "utf8");

// Exact legacy exceptions only. Do not add new product pages here; migrate or
// place them under a feature directory instead. x-search-page is retained only
// because its pre-existing test suite still imports it while /x-search redirects.
const ROOT_ALLOWLIST = new Set([
  "App.tsx",
  "main.tsx",
  "daily-briefing-pages.tsx",
  "x-search-page.tsx",
]);

for (const file of sourceFiles) {
  const rel = relative(file);
  if (!rel.includes("/") && file.endsWith(".tsx") && !ROOT_ALLOWLIST.has(rel)) {
    errors.push(`${rel}: new production TSX belongs in a feature/shell directory, not src/.`);
  }

  const bytes = fs.statSync(file).size;
  const limit = rel === "daily-briefing-pages.tsx" ? 24_000 : 18_000;
  if (bytes > limit) {
    errors.push(`${rel}: ${bytes} bytes exceeds the ${limit}-byte architecture ceiling; split responsibilities.`);
  }
}

const appPath = path.join(srcRoot, "morning-briefing", "MorningBriefingApp.tsx");
const appSource = read(appPath);
if (Buffer.byteLength(appSource, "utf8") > 6_000) {
  errors.push("morning-briefing/MorningBriefingApp.tsx: route shell exceeds 6 KB; extract feature responsibilities.");
}
for (const forbidden of ["fetch(", "useSentiment", "useXPosts", "useEarnings"]) {
  if (appSource.includes(forbidden)) {
    errors.push(`morning-briefing/MorningBriefingApp.tsx: route shell must not own ${forbidden}.`);
  }
}

const morningDir = path.join(srcRoot, "morning-briefing");
for (const file of sourceFiles.filter((item) => item.startsWith(morningDir))) {
  const rel = relative(file);
  if (read(file).includes("fetch(") && rel !== "morning-briefing/api-client.ts") {
    errors.push(`${rel}: raw fetch is centralized in morning-briefing/api-client.ts.`);
  }
}

const routeBoundaries = [
  ["morning-briefing/MorningBriefingPage.tsx", ["useXPosts", "useEarnings"]],
  ["morning-briefing/XPulsePage.tsx", ["useSentiment", "useEarnings"]],
  ["morning-briefing/EarningsCalendarPage.tsx", ["useSentiment", "useXPosts"]],
];
for (const [rel, forbiddenImports] of routeBoundaries) {
  const source = read(path.join(srcRoot, rel));
  for (const forbidden of forbiddenImports) {
    if (source.includes(forbidden)) {
      errors.push(`${rel}: route must not import unrelated data hook ${forbidden}.`);
    }
  }
}

if (errors.length) {
  console.error("Architecture guard failed:\n");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Architecture guard passed (${sourceFiles.length} production TS/TSX files checked).`);
