"use strict";
// Runner for .github/workflows/collab-intake.yml.
// Reads the comment event, asks src/intake.js what to post, re-reads everything
// right before posting, and posts at most one comment. Any failure exits
// non-zero and is NOT retried. Logs carry fixed codes only: never comment text,
// tokens, URLs or API responses.

const fs = require("node:fs");
const path = require("node:path");
const { plan, stateFromComments, WORK_LABEL, BOT_LOGIN } = require("../src/intake");

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
    addLabel: (number) => gh("POST", `/repos/${repo}/issues/${number}/labels`, { labels: [WORK_LABEL] }),
    removeLabel: async (number) => {
      try {
        await gh("DELETE", `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(WORK_LABEL)}`);
      } catch (err) {
        if (!(err instanceof IntakeError && err.code === "E_API_DELETE_404")) throw err; // already gone
      }
    },
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

/**
 * Amu's Work result on a pull request ends the Work request: take the Work
 * label off so that further comments on this PR no longer wake Work.
 * Only the owner's "[AMU-RESULT] request=<ID>" on a PR counts, and only when
 * <ID> is a routed Work request of this PR in the bot's own records.
 * Posts nothing.
 */
async function finishWork(ctx, log) {
  const { event, api, repo } = ctx;
  if (!event.issue.pull_request) return log("intake: result on an Issue; nothing to do");
  const ownerId = event.repository && event.repository.owner ? event.repository.owner.id : null;
  if (ownerId == null) throw new IntakeError("E_OWNER_UNKNOWN");
  const comment = await api.getComment(event.comment.id);
  if (!comment) return log("intake: comment no longer exists; nothing to do");
  if (!isValidComment(comment)) throw new IntakeError("E_COMMENT_MALFORMED");
  const isOwner = comment.author_association === "OWNER" && comment.user.id === ownerId;
  const m = /^\[AMU-RESULT\] request=([A-Za-z0-9._-]+)(?:\s|$)/.exec(comment.body.trimStart());
  if (!isOwner || !m) return log("intake: not an owner result for a request; nothing to do");
  const prefix = `${repo}#${event.issue.number}#`;
  const comments = await api.listComments(event.issue.number);
  const { ledger, broken } = stateFromComments(comments, prefix);
  if (broken) return log("intake: broken bot record; label left as is");
  const entry = ledger[`${prefix}${m[1]}`];
  if (!entry || entry.state !== "routed" || entry.lane !== "work") {
    return log("intake: no routed Work request with this ID; nothing to do");
  }
  // Remove the label only when no Work request on this PR is still open, i.e.
  // every routed Work request has an owner [AMU-RESULT] for its ID.
  const finished = new Set();
  for (const c of comments) {
    if (!isValidComment(c) || c.author_association !== "OWNER" || c.user.id !== ownerId) continue;
    const r = /^\[AMU-RESULT\] request=([A-Za-z0-9._-]+)(?:\s|$)/.exec(c.body.trimStart());
    if (r) finished.add(`${prefix}${r[1]}`);
  }
  const open = Object.entries(ledger).filter(([k, e]) => e.state === "routed" && e.lane === "work" && !finished.has(k));
  if (open.length > 0) return log("intake: another Work request is still open; label left as is");
  await api.removeLabel(event.issue.number);
  log("intake: work label removed");
}

async function run(ctx, log = () => {}) {
  if (String(ctx.event.comment && ctx.event.comment.body || "").trimStart().startsWith("[AMU-RESULT]")) {
    return finishWork(ctx, log);
  }
  const first = await snapshot(ctx);
  if (!first) return log("intake: comment no longer exists; nothing to do");
  log(`intake: action=${first.action} reason=${first.reason} post=${first.body ? "yes" : "no"}`);
  if (!first.body) return;

  // Right before the side effect, read everything again (the request and its
  // author, every other comment incl. cancels and results already posted, and
  // the PR head) and plan again. Post only if nothing changed the outcome.
  const again = await snapshot(ctx);
  if (!again || again.body !== first.body || again.seen !== first.seen || again.label !== first.label) {
    return log("intake: state changed while processing; stopping without posting");
  }
  const number = ctx.event.issue.number;
  if (first.label !== "add") {
    await ctx.api.postComment(number, first.body);
    if (first.label === "remove") await ctx.api.removeLabel(number);
    return;
  }
  // Work on a PR: the label must be on the PR before the routing comment
  // exists, because the comment is what wakes the Work task. If the label
  // fails, post nothing. Adding the label takes time, so read everything once
  // more; if anything changed (e.g. a cancel), take the label off and stop.
  // If posting fails, take the label off again (one attempt, no retry).
  await ctx.api.addLabel(number);
  let third;
  try {
    third = await snapshot(ctx);
  } catch (err) {
    try { await ctx.api.removeLabel(number); } catch { /* reported by the original error below */ }
    throw err;
  }
  if (!third || third.body !== first.body || third.seen !== first.seen || third.label !== first.label) {
    await ctx.api.removeLabel(number);
    return log("intake: state changed while adding the label; label removed, nothing posted");
  }
  try {
    await ctx.api.postComment(number, first.body);
  } catch (err) {
    // The comment may have been saved even though the answer was lost. Only
    // if we can see that it was NOT saved, take the label off again. If we
    // cannot tell, keep the label (a left-over label only wakes Work, which
    // then ends without doing anything).
    let saved = null;
    try {
      const now = await ctx.api.listComments(number);
      const norm = (t) => String(t).replace(/\r\n/g, "\n");
      saved = now.some((c) => c && c.user && c.user.login === BOT_LOGIN && c.user.type === "Bot" && norm(c.body) === norm(first.body));
    } catch { saved = null; }
    if (saved === false) {
      try { await ctx.api.removeLabel(number); } catch { /* reported by the original error below */ }
    }
    throw err;
  }
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
