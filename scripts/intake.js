"use strict";
// Runner for .github/workflows/collab-intake.yml.
// Reads the comment event, asks src/intake.js what to post, posts at most one
// comment. Any failure exits non-zero and is NOT retried. Logs never include
// comment text, tokens or API responses.

const fs = require("node:fs");
const path = require("node:path");
const { plan } = require("../src/intake");

const api = process.env.GITHUB_API_URL || "https://api.github.com";
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;

async function gh(method, url, body) {
  const res = await fetch(`${api}${url}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404 && method === "GET") return null;
  if (!res.ok) throw new Error(`GitHub API ${method} failed with status ${res.status}`);
  return res.json();
}

const MAX_PAGES = 10;

// Partial history must never be treated as authoritative: if the last allowed
// page is still full, stop (throw) instead of planning from a truncated ledger.
async function listComments(number, fetchPage = (page) =>
  gh("GET", `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`)) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await fetchPage(page);
    if (!batch || batch.length === 0) return all;
    all.push(...batch);
    if (batch.length < 100) return all;
  }
  throw new Error(`comment history exceeds ${MAX_PAGES * 100} comments; refusing to plan from partial history`);
}

async function main() {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const number = event.issue.number;
  const isPullRequest = Boolean(event.issue.pull_request);
  const commentUrl = `/repos/${repo}/issues/comments/${event.comment.id}`;

  const comment = await gh("GET", commentUrl); // latest text, not the queued event's
  if (!comment) return console.log("intake: comment no longer exists; nothing to do");

  const registry = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "collab", "registry.json"), "utf8"));
  const comments = await listComments(number);
  let headSha = null;
  if (isPullRequest) {
    const pr = await gh("GET", `/repos/${repo}/pulls/${number}`);
    headSha = pr && pr.head ? pr.head.sha : null;
  }

  const result = plan({ repo, thread: number, isPullRequest, headSha, comment, comments, registry });
  console.log(`intake: action=${result.action} reason=${result.reason} post=${result.body ? "yes" : "no"}`);
  if (!result.body) return;

  // Last check right before the side effect: the comment must be unchanged.
  const again = await gh("GET", commentUrl);
  if (!again || again.updated_at !== comment.updated_at) {
    return console.log("intake: comment changed while processing; stopping (the edit starts its own run)");
  }
  await gh("POST", `/repos/${repo}/issues/${number}/comments`, { body: result.body });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`intake: failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { listComments };
