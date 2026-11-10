"use strict";
// Runner for .github/workflows/collab-intake.yml.
// Reads the comment event, asks src/intake.js what to post, re-reads everything
// right before posting, and posts at most one comment. Any failure exits
// non-zero and is NOT retried. Logs carry fixed codes only: never comment text,
// tokens, URLs or API responses.

const fs = require("node:fs");
const path = require("node:path");
const { plan } = require("../src/intake");

const MAX_PAGES = 10;
const FULL_SHA = /^[0-9a-f]{40}$/;

/** A comment as GitHub returns it. Anything else means the data is unknown. */
function isValidComment(c) {
  return Boolean(c) && typeof c === "object"
    && Number.isSafeInteger(c.id) && c.id > 0
    && typeof c.body === "string"
    && typeof c.author_association === "string"
    && Boolean(c.user) && typeof c.user === "object"
    && typeof c.user.login === "string" && Number.isSafeInteger(c.user.id) && c.user.id > 0
    && typeof c.user.type === "string";
}

class IntakeError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function githubApi(repo, token, base) {
  async function gh(method, url, body) {
    let res;
    try {
      res = await fetch(`${base}${url}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch { throw new IntakeError("E_NETWORK"); }
    if (res.status === 404 && method === "GET") return null;
    if (!res.ok) throw new IntakeError(`E_API_${method}_${res.status}`);
    try { return await res.json(); } catch { throw new IntakeError("E_API_BAD_RESPONSE"); }
  }
  return {
    getComment: (id) => gh("GET", `/repos/${repo}/issues/comments/${id}`),
    listComments: (number) => listComments(number, (page) =>
      gh("GET", `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`)),
    getHeadSha: async (number) => {
      const pr = await gh("GET", `/repos/${repo}/pulls/${number}`);
      return pr && pr.head ? pr.head.sha : null;
    },
    postComment: (number, body) => gh("POST", `/repos/${repo}/issues/${number}/comments`, { body }),
  };
}

// Partial history must never be treated as authoritative: if the last allowed
// page is still full, stop (throw) instead of planning from a truncated ledger.
async function listComments(number, fetchPage) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await fetchPage(page);
    // Only a real empty list ends the history. A missing page (404 -> null) or
    // anything that is not a list means the history is unknown: stop.
    if (!Array.isArray(batch)) throw new IntakeError("E_HISTORY_UNAVAILABLE");
    if (!batch.every(isValidComment)) throw new IntakeError("E_HISTORY_MALFORMED");
    if (batch.length === 0) return all;
    all.push(...batch);
    if (batch.length < 100) return all;
  }
  throw new IntakeError("E_HISTORY_TOO_LONG");
}

/** One full read of the current state on GitHub, turned into a plan. */
async function snapshot({ event, repo, registry, api }) {
  const number = event.issue.number;
  const isPullRequest = Boolean(event.issue.pull_request);
  const ownerId = event.repository && event.repository.owner ? event.repository.owner.id : null;
  if (ownerId == null) throw new IntakeError("E_OWNER_UNKNOWN");
  const comment = await api.getComment(event.comment.id); // latest text, not the queued event's
  if (!comment) return null;
  if (!isValidComment(comment)) throw new IntakeError("E_COMMENT_MALFORMED");
  const comments = await api.listComments(number);
  const headSha = isPullRequest ? await api.getHeadSha(number) : null;
  if (isPullRequest && !(typeof headSha === "string" && FULL_SHA.test(headSha))) {
    throw new IntakeError("E_HEAD_UNKNOWN");
  }
  const result = plan({ repo, thread: number, isPullRequest, headSha, ownerId, comment, comments, registry });
  // What the decision was based on, to compare with the second read.
  const seen = JSON.stringify([
    comment.id, comment.body, comment.updated_at, comment.author_association,
    comment.user ? comment.user.id : null, headSha,
  ]);
  return { ...result, seen };
}

async function run(ctx, log = () => {}) {
  const first = await snapshot(ctx);
  if (!first) return log("intake: comment no longer exists; nothing to do");
  log(`intake: action=${first.action} reason=${first.reason} post=${first.body ? "yes" : "no"}`);
  if (!first.body) return;

  // Right before the side effect, read everything again (the request and its
  // author, every other comment incl. cancels and results already posted, and
  // the PR head) and plan again. Post only if nothing changed the outcome.
  const again = await snapshot(ctx);
  if (!again || again.body !== first.body || again.seen !== first.seen) {
    return log("intake: state changed while processing; stopping without posting");
  }
  await ctx.api.postComment(ctx.event.issue.number, first.body);
}

if (require.main === module) {
  const repo = process.env.GITHUB_REPOSITORY;
  const ctx = {
    event: JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")),
    repo,
    registry: JSON.parse(fs.readFileSync(path.join(__dirname, "..", "collab", "registry.json"), "utf8")),
    api: githubApi(repo, process.env.GITHUB_TOKEN, process.env.GITHUB_API_URL || "https://api.github.com"),
  };
  run(ctx, console.log).catch((err) => {
    console.error(`intake: failed code=${err instanceof IntakeError ? err.code : "E_UNEXPECTED"}`);
    process.exit(1);
  });
}

module.exports = { listComments, run };
