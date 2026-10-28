"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { codexStarted, decide } = require("../scripts/codex-request-decision");

const SHA = "f0bc065e4d230fdcb21cc5371f28eb1007e0ac57";
const OTHER = "1111111111111111111111111111111111111111";
const CODEX = "chatgpt-codex-connector[bot]";

test("codex summary comment containing the sha counts as started", () => {
  const comments = [{ user: { login: CODEX }, body: `state {"commit_sha":"${SHA}"}` }];
  assert.equal(codexStarted(SHA, comments, []), true);
});

test("codex formal review on the same commit_id counts as started", () => {
  const reviews = [{ user: { login: CODEX }, commit_id: SHA }];
  assert.equal(codexStarted(SHA, [], reviews), true);
});

test("a review or comment for an older commit does not count", () => {
  const comments = [{ user: { login: CODEX }, body: `sha ${OTHER}` }];
  const reviews = [{ user: { login: CODEX }, commit_id: OTHER }];
  assert.equal(codexStarted(SHA, comments, reviews), false);
});

test("a human review on the commit does not count as codex", () => {
  const reviews = [{ user: { login: "someone" }, commit_id: SHA }];
  assert.equal(codexStarted(SHA, [], reviews), false);
});

test("decide: requests when codex has not started and nothing was requested", () => {
  assert.deepEqual(decide({ sha: SHA, comments: [], reviews: [], maxRequests: 3 }), { action: "request" });
});

test("decide: skips when codex already reviewed this commit", () => {
  const reviews = [{ user: { login: CODEX }, commit_id: SHA }];
  assert.equal(decide({ sha: SHA, comments: [], reviews, maxRequests: 3 }).action, "skip");
});

test("decide: skips when this commit was already requested", () => {
  const comments = [{ user: { login: "github-actions[bot]" }, body: `<!-- codex-auto-request:${SHA} -->` }];
  assert.equal(decide({ sha: SHA, comments, reviews: [], maxRequests: 3 }).action, "skip");
});

test("decide: skips once the per-PR cap is reached", () => {
  const comments = ["a", "b", "c"].map((x) => ({
    user: { login: "github-actions[bot]" }, body: `<!-- codex-auto-request:${x.repeat(40)} -->`,
  }));
  assert.equal(decide({ sha: SHA, comments, reviews: [], maxRequests: 3 }).action, "skip");
});
