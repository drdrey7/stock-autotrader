import assert from "node:assert/strict";
import test from "node:test";
import { safeMarkdownUrl } from "../src/lib/analysis/markdown-url.ts";

test("safeMarkdownUrl allows web URLs, fragments and app paths", () => {
  assert.equal(safeMarkdownUrl("https://example.com/research?q=1"), "https://example.com/research?q=1");
  assert.equal(safeMarkdownUrl("http://example.com/"), "http://example.com/");
  assert.equal(safeMarkdownUrl("#risk"), "#risk");
  assert.equal(safeMarkdownUrl("/stocks/NVDA"), "/stocks/NVDA");
});

test("safeMarkdownUrl rejects executable and protocol-relative URLs", () => {
  assert.equal(safeMarkdownUrl("javascript:alert(1)"), "");
  assert.equal(safeMarkdownUrl("data:text/html,hello"), "");
  assert.equal(safeMarkdownUrl("//evil.example/steal"), "");
  assert.equal(safeMarkdownUrl("/\\\\attacker.example"), "");
});
