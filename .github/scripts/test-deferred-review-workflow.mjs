import assert from "node:assert/strict";
import fs from "node:fs";

const workflow = fs.readFileSync(".github/workflows/deferred-review-issues.yml", "utf8");
assert.match(workflow, /comments\s*\.slice\(1\)/, "workflow must exclude the root comment from marker detection");
assert.match(workflow, /markerReply/, "workflow must retain the later marker reply for Issue provenance");

const marker = /(?:^|\n)\s*(?:\[(?:accepted|deferred)\]|(?:accepted|deferred)\s*:\s*(?:accepted|deferred|yes|true))\s*(?:$|\n)/i;
const priority = (body) => [...(body ?? "").matchAll(/\bP([0-3])\b/gi)].map((match) => Number(match[1]));
const markerReplyAfterRoot = (comments) => {
  const root = comments[0];
  if (!root) return null;
  return comments.slice(1).find((comment) => comment.createdAt > root.createdAt && marker.test(comment.body ?? "")) ?? null;
};
const shouldCreateIssue = (comments) => {
  const priorities = priority(comments[0]?.body);
  const minimum = priorities.length ? Math.min(...priorities) : null;
  return minimum !== null && minimum >= 2 && minimum <= 3 && markerReplyAfterRoot(comments) !== null;
};
const comment = (body, createdAt) => ({ body, createdAt });

// Root examples are explanatory text only and cannot self-accept.
assert.equal(shouldCreateIssue([comment("P2 finding demonstrates [deferred]", "2026-08-14T06:00:00Z")]), false);
assert.equal(shouldCreateIssue([
  comment("P2 finding", "2026-08-14T06:00:00Z"),
  comment("[deferred]", "2026-08-14T06:01:00Z"),
]), true);
assert.equal(shouldCreateIssue([
  comment("P3 finding", "2026-08-14T06:00:00Z"),
  comment("Accepted: deferred", "2026-08-14T06:01:00Z"),
]), true);
assert.equal(shouldCreateIssue([
  comment("P1 blocker", "2026-08-14T06:00:00Z"),
  comment("[deferred]", "2026-08-14T06:01:00Z"),
]), false);

// Repeated runs use the stable thread ID marker and create one Issue only.
const issuesByThread = new Map();
for (let run = 0; run < 2; run += 1) {
  const threadId = "PRRT_stable_example";
  if (!issuesByThread.has(threadId) && shouldCreateIssue([
    comment("P2 finding", "2026-08-14T06:00:00Z"),
    comment("[accepted]", "2026-08-14T06:01:00Z"),
  ])) issuesByThread.set(threadId, { number: 1 });
}
assert.equal(issuesByThread.size, 1);

console.log("deferred review workflow regression checks passed");
