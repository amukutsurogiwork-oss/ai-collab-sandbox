"use strict";

// Decision logic for the "Request Codex review" workflow (sandbox trial).
// Pure functions so the guard is unit-tested; the workflow only fetches JSON and calls this.

const CODEX_LOGIN = "chatgpt-codex-connector[bot]";
const MARKER = "codex-auto-request:";

function codexStarted(sha, comments, reviews) {
  const inComment = (comments || []).some(
    (c) => c.user && c.user.login === CODEX_LOGIN && typeof c.body === "string" && c.body.includes(sha),
  );
  const inReview = (reviews || []).some(
    (r) => r.user && r.user.login === CODEX_LOGIN && r.commit_id === sha,
  );
  return inComment || inReview;
}

function decide({ sha, comments, reviews, maxRequests }) {
  if (codexStarted(sha, comments, reviews)) {
    return { action: "skip", reason: "codex already started on this commit" };
  }
  const marked = (comments || []).filter((c) => typeof c.body === "string" && c.body.includes(MARKER));
  if (marked.some((c) => c.body.includes(MARKER + sha))) {
    return { action: "skip", reason: "already requested for this commit" };
  }
  if (marked.length >= maxRequests) {
    return { action: "skip", reason: "per-PR request cap reached" };
  }
  return { action: "request" };
}

module.exports = { codexStarted, decide };

if (require.main === module) {
  // usage: node codex-request-decision.js <sha> <comments.json> <reviews.json> <max>
  const fs = require("node:fs");
  const [sha, commentsPath, reviewsPath, max] = process.argv.slice(2);
  const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
  const started = codexStarted(sha, read(commentsPath), read(reviewsPath));
  const result = decide({ sha, comments: read(commentsPath), reviews: read(reviewsPath), maxRequests: Number(max) });
  console.log(started ? "started" : result.action);
}
