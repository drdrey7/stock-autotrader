import assert from "node:assert/strict";
import test from "node:test";
import { safeReturnPath } from "../src/lib/auth/return-path.ts";

const ORIGIN = "https://ai.example";

test("safeReturnPath accepts same-origin internal paths", () => {
  assert.equal(safeReturnPath("/app", ORIGIN), "/app");
  assert.equal(safeReturnPath("/report/abc-123?x=1#top", ORIGIN), "/report/abc-123?x=1#top");
  assert.equal(safeReturnPath("/account", ORIGIN), "/account");
});

test("safeReturnPath rejects open redirects", () => {
  assert.equal(safeReturnPath(null, ORIGIN), "/app");
  assert.equal(safeReturnPath("", ORIGIN), "/app");
  assert.equal(safeReturnPath("https://evil.example/phish", ORIGIN), "/app");
  assert.equal(safeReturnPath("//evil.example", ORIGIN), "/app");
  assert.equal(safeReturnPath("/\\evil.example", ORIGIN), "/app");
  assert.equal(safeReturnPath("/\\\\evil.example", ORIGIN), "/app");
  assert.equal(safeReturnPath("/%5C%5Cevil.example", ORIGIN), "/app");
  assert.equal(safeReturnPath("/%5cevil.example", ORIGIN), "/app");
  assert.equal(safeReturnPath("\\evil.example", ORIGIN), "/app");
  assert.equal(safeReturnPath("app", ORIGIN), "/app");
});
