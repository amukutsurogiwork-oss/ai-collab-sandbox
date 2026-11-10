"use strict";

const LANES = ["chat", "work", "codex", "mone"];
const STATUSES = ["open", "cancel"];
// Always stop for the owner, whatever the registry says.
const ALWAYS_APPROVAL = ["paid", "production", "secrets", "permissions"];

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

/** Ledger key: the same request ID in another repo or Issue/PR is a different request. */
function requestKey(request) {
  return `${request.repo}#${request.thread}#${request.id}`;
}

/** Validate one registry entry; returns a list of problems (empty = ok). */
function validateProject(p) {
  const errors = [];
  if (!p || typeof p !== "object") return ["entry must be an object"];
  if (!/^[\w.-]+\/[\w.-]+$/.test(p.repo || "")) errors.push("repo must be owner/name");
  if (!Array.isArray(p.allowedLanes) || p.allowedLanes.length === 0) {
    errors.push("allowedLanes must be a non-empty array");
  } else if (p.allowedLanes.some((l) => !LANES.includes(l))) {
    errors.push("allowedLanes has an unknown lane");
  }
  if (!Array.isArray(p.allowedOperations)) errors.push("allowedOperations must be an array");
  if (p.approvalRequired !== undefined && !Array.isArray(p.approvalRequired)) {
    errors.push("approvalRequired must be an array");
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

  const key = requestKey(request);
  const entry = ledger[key];
  if (entry && request.commentId && entry.commentIds.includes(request.commentId)) {
    return result("skip-duplicate", "comment already processed");
  }

  const record = (state) => ({
    ...ledger,
    [key]: {
      state,
      sha: request.sha || (entry && entry.sha) || null,
      commentIds: [...((entry && entry.commentIds) || []), request.commentId].filter(Boolean),
    },
  });

  // Cancel wins over everything else, even after the request was routed.
  if (request.status === "cancel") {
    return result("cancel", "cancelled by requester", { ledger: record("cancelled") });
  }
  if (entry && entry.state === "cancelled") return result("skip-cancelled", "request was cancelled");
  if (entry && entry.state === "routed") return result("skip-duplicate", "request already routed");

  if (!LANES.includes(request.lane)) return result("reject", "unknown lane");
  if (!project.allowedLanes.includes(request.lane)) return result("reject", "lane not allowed for project");
  if (!request.operation) return result("reject", "operation missing");
  if (!project.allowedOperations.includes(request.operation)) {
    return result("reject", "operation not allowed for project");
  }
  const needsApproval =
    (project.approvalRequired || []).includes(request.operation) ||
    request.flags.some((f) => ALWAYS_APPROVAL.includes(f));
  if (needsApproval) return result("needs-approval", "stop and ask the owner", { lane: "mone" });

  return result("route", "ok", { lane: request.lane, ledger: record("routed") });
}

/**
 * Re-check right before a side effect (posting a comment, writing, deploying).
 * `latest` is what the caller just fetched: the newest ledger, the current PR
 * head SHA, and whether a result was already posted.
 */
function guardSideEffect(request, latest = {}) {
  const stop = (reason) => ({ ok: false, reason });
  const entry = (latest.ledger || {})[requestKey(request)];
  if (!entry || entry.state === "cancelled") return stop(entry ? "cancelled" : "not routed");
  if (latest.alreadyPosted) return stop("result already posted");
  if (entry.sha && latest.headSha && entry.sha !== latest.headSha) return stop("stale sha");
  if (entry.sha && !latest.headSha) return stop("head sha unknown");
  return { ok: true, reason: "ok" };
}

module.exports = { LANES, parseRequest, requestKey, validateProject, decide, guardSideEffect };
