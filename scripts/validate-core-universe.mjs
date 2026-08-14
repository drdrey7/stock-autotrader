#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const filePath = path.join(repoRoot, "packages/contracts/src/core-universe.v1.json");
const expectedKeys = ["symbols", "version"];
const symbolPattern = /^[A-Z][A-Z0-9-]{0,11}$/;
const expectedV1Size = 50;
const compareSymbols = (left, right) => left < right ? -1 : left > right ? 1 : 0;

let config;
try {
  config = JSON.parse(readFileSync(filePath, "utf8"));
} catch (error) {
  throw new Error(`Unable to parse Core Universe config at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
}

if (!config || typeof config !== "object" || Array.isArray(config)) {
  throw new Error("Core Universe config must be a JSON object");
}
const keys = Object.keys(config).sort();
if (keys.join(",") !== expectedKeys.join(",")) {
  throw new Error("Core Universe config must contain only version and symbols");
}
if (!Number.isInteger(config.version) || config.version < 1) {
  throw new Error("Core Universe version must be a positive integer");
}
if (!Array.isArray(config.symbols)) throw new Error("Core Universe symbols must be an array");
if (config.version === 1 && config.symbols.length !== expectedV1Size) {
  throw new Error(`Core Universe v1 must contain exactly ${expectedV1Size} symbols`);
}
const seen = new Set();
for (const [index, symbol] of config.symbols.entries()) {
  if (typeof symbol !== "string" || symbol !== symbol.trim() || !symbolPattern.test(symbol)) {
    throw new Error(`Core Universe symbol at index ${index} is not a normalized ticker`);
  }
  if (seen.has(symbol)) throw new Error(`Core Universe contains duplicate symbol: ${symbol}`);
  seen.add(symbol);
}
const sorted = [...config.symbols].sort(compareSymbols);
if (config.symbols.some((symbol, index) => symbol !== sorted[index])) {
  throw new Error("Core Universe symbols must use deterministic lexicographic ordering");
}
console.log(`Core Universe v${config.version}: ${config.symbols.length} unique normalized symbols`);
