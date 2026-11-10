"use strict";

const LANES = ["chat", "work", "codex", "mone"];
const STATUSES = ["open", "cancel"];
// Always stop for the owner, whatever the registry says. Checked against both
// the operation itself and the requester's flags (fail closed).
const ALWAYS_APPROVAL = ["paid", "production", "deploy", "secrets", "permissions", "delete", "publish"];
const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const SAFE_THREAD = /^[1-9][0-9]*$/;

/**
 * Parse a "[MONE-REQUEST] id=<ID> lane=<lane> op=<op> status=open|cancel sha=<SHA>" comment.
 * Returns null when the comment is not a request. Nothing in the comment
 * text can grant approval: words like "approved" are ignored.
 */
function parseRequest(body, meta = {}) {
  const first = String(body || "").split("\n")[0].trim();
  if (!first.startsWith("[MONE-REQUEST]")) return null;
  const fields = {};
  for (const part of first.slice("[MONE-REQUEST]".length).trim().split(/\s+/)) {
    const i = part.indexOf("=");
    if (i > 0) fields[part.slice(0, i)] = part.slice(i + 1);
  }
  if (!fields.id) return null;
  return {
    id: fields.id,
    lane: fields.lane || "",
    status: fields.status === undefined ? "open" : fields.status,
    sha: fields.sha || null,
    operation: fields.op || "",
    flags: (fields.flags || "").split(",").filter(Boolean),
    repo: meta.repo || "",
    thread: meta.thread == null ? "" : String(meta.thread),
    commentId: meta.commentId == null ? null : String(meta.commentId),
  };
}

function normalizeFlags(flags) {
  return [...new Set(flags || [])].sort().join(",");
}

/** Ledger key: the same request ID in another repo or Issue/PR is a different request. */
function requestKey(request) {
  return `${request.repo}#${request.thread}#${request.id}`;
}

/** Validate one registry entry; returns a list of problems (empty = ok). */
function validateProject(p) {
  const errors = [];
  if (!p || typeof p !== "object") return ["entry must be an object"];
  const isStrings = (v) => Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
  if (!/^[\w.-]+\/[\w.-]+$/.test(p.repo || "")) errors.push("repo must be owner/name");
  if (!isStrings(p.allowedLanes) || p.allowedLanes.length === 0) {
    errors.push("allowedLanes must be a non-empty array of strings");
  } else if (p.allowedLanes.some((l) => !LANES.includes(l))) {
    errors.push("allowedLanes has an unknown lane");
  }
  if (!isStrings(p.allowedOperations)) errors.push("allowedOperations must be an array of strings");
  for (const field of ["approvalRequired", "guiOperations"]) {
    if (p[field] !== undefined && !isStrings(p[field])) errors.push(`${field} must be an array of strings`);
  }
  if (isStrings(p.allowedOperations) && isStrings(p.guiOperations)
      && p.guiOperations.some((op) => !p.allowedOperations.includes(op))) {
    errors.push("guiOperations must be listed in allowedOperations");
  }
  return errors;
}

/**
 * Decide what to do with a request. Pure function: the caller keeps the
 * ledger (GitHub is the source of truth) and applies the returned `ledger`.
 * ledger: { [requestKey]: { state: "routed"|"cancelled", commentIds: string[], sha } }
 */
function decide(request, registry, ledger = {}) {
  const result = (action, reason, extra = {}) => ({ action, reason, ...extra });
  if (!request) return result("ignore", "not a request");

  const project = (registry.projects || []).find((p) => p.repo === request.repo);
  if (!project) return result("reject", "project not registered");
  if (validateProject(project).length) return result("reject", "registry entry invalid");
  if (!STATUSES.includes(request.status)) return result("reject", "unknown status");
  if (!SAFE_THREAD.test(request.thread)) return result("reject", "invalid thread");
  if (!SAFE_ID.test(request.id)) return result("reject", "invalid id");

  const key = requestKey(request);
  const entry = ledger[key];
  const record = (state, extra = {}) => ({
    ...ledger,
    [key]: {
      ...(entry || {}),
      ...extra,
      state,
      commentIds: [...new Set([...((entry && entry.commentIds) || []), request.commentId].filter(Boolean))],
    },
  });

  // One real comment is one request. If this comment was already used under a
  // different request ID (the ID was edited), stop instead of routing a second one.
  if (request.commentId) {
    const prefix = `${request.repo}#${request.thread}#`;
    const owner = Object.keys(ledger).find(
      (k) => k !== key && k.startsWith(prefix) && ledger[k].commentIds.includes(request.commentId));
    if (owner) return result("reject", "comment already bound to another request");
  }

  // Cancel wins over everything else, even an edit of an already routed comment.
  if (request.status === "cancel") {
    if (entry && entry.state === "cancelled") return result("skip-cancelled", "already cancelled");
    return result("cancel", "cancelled by requester", { ledger: record("cancelled") });
  }
  if (entry && entry.state === "cancelled") return result("skip-cancelled", "request was cancelled");
  if (entry && request.commentId && entry.commentIds.includes(request.commentId)) {
    return result("skip-duplicate", "comment already processed");
  }
  if (entry && entry.state === "routed") return result("skip-duplicate", "request already routed");

  if (!LANES.includes(request.lane)) return result("reject", "unknown lane");
  if (!project.allowedLanes.includes(request.lane)) return result("reject", "lane not allowed for project");
  if (!request.operation) return result("reject", "operation missing");
  if (!project.allowedOperations.includes(request.operation)) {
    return result("reject", "operation not allowed for project");
  }
  if (request.lane === "work" && !(project.guiOperations || []).includes(request.operation)) {
    return result("reject", "work lane needs a GUI operation");
  }
  const needsApproval =
    ALWAYS_APPROVAL.includes(request.operation) ||
    (project.approvalRequired || []).includes(request.operation) ||
    request.flags.some((f) => ALWAYS_APPROVAL.includes(f));
  if (needsApproval) return result("needs-approval", "stop and ask the owner", { lane: "mone" });

  return result("route", "ok", {
    lane: request.lane,
    ledger: record("routed", {
      lane: request.lane, operation: request.operation, sha: request.sha, flags: normalizeFlags(request.flags),
    }),
  });
}

/**
 * Re-check right before a side effect (posting a comment, writing, deploying).
 * `latest` is what the caller just fetched: the newest ledger, the current PR
 * head SHA, and whether a result was already posted.
 */
function guardSideEffect(request, latest = {}) {
  const stop = (reason) => ({ ok: false, reason });
  if (request.status !== "open") return stop("request is not open");
  const entry = (latest.ledger || {})[requestKey(request)];
  if (entry && entry.state === "cancelled") return stop("cancelled");
  if (!entry || entry.state !== "routed") return stop("not routed");
  // An edit must never add an approval-sensitive operation or flag.
  if (ALWAYS_APPROVAL.includes(request.operation) || request.flags.some((f) => ALWAYS_APPROVAL.includes(f))) {
    return stop("needs approval");
  }
  // Only the exact request that was routed may act.
  if (entry.lane !== request.lane || entry.operation !== request.operation
      || (entry.sha || null) !== (request.sha || null)
      || (entry.flags || "") !== normalizeFlags(request.flags)) {
    return stop("request changed");
  }
  if (latest.alreadyPosted) return stop("result already posted");
  // The caller must say, from trusted GitHub data, whether the target is a PR.
  if (typeof latest.isPullRequest !== "boolean") return stop("target type unknown");
  if (latest.isPullRequest && !entry.sha) return stop("pull request needs sha");
  if (entry.sha && !latest.headSha) return stop("head sha unknown");
  if (entry.sha && entry.sha !== latest.headSha) return stop("stale sha");
  return { ok: true, reason: "ok" };
}

module.exports = { LANES, parseRequest, requestKey, validateProject, decide, guardSideEffect };
