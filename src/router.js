"use strict";

const LANES = ["chat", "work", "codex", "mone"];
const NEEDS_APPROVAL = ["paid", "production", "secrets", "permissions"];

/**
 * Parse a "[MONE-REQUEST] id=<ID> lane=<lane> status=open|cancel ..." comment.
 * Returns null when the comment is not a request.
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
    status: fields.status === "cancel" ? "cancel" : "open",
    sha: fields.sha || null,
    operation: fields.op || "",
    flags: (fields.flags || "").split(",").filter(Boolean),
    repo: meta.repo || "",
    commentId: meta.commentId == null ? null : String(meta.commentId),
  };
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
  return errors;
}

/**
 * Decide what to do with a request. Pure function: the caller keeps the
 * ledger (GitHub is the source of truth) and applies the returned `ledger`.
 * ledger: { [requestId]: { state: "routed"|"cancelled", commentIds: string[] } }
 */
function decide(request, registry, ledger = {}) {
  const result = (action, reason, extra = {}) => ({ action, reason, ...extra });
  if (!request) return result("ignore", "not a request");

  const project = (registry.projects || []).find((p) => p.repo === request.repo);
  if (!project) return result("reject", "project not registered");
  if (validateProject(project).length) return result("reject", "registry entry invalid");

  const entry = ledger[request.id];
  const seen = entry && request.commentId && entry.commentIds.includes(request.commentId);
  if (seen) return result("skip-duplicate", "comment already processed");

  const record = (state) => ({
    ...ledger,
    [request.id]: {
      state,
      commentIds: [...((entry && entry.commentIds) || []), request.commentId].filter(Boolean),
    },
  });

  if (request.status === "cancel") {
    return result("cancel", "cancelled by requester", { ledger: record("cancelled") });
  }
  if (entry && entry.state === "cancelled") return result("skip-cancelled", "request was cancelled");
  if (entry && entry.state === "routed") return result("skip-duplicate", "request already routed");

  if (!LANES.includes(request.lane)) return result("reject", "unknown lane");
  if (!project.allowedLanes.includes(request.lane)) return result("reject", "lane not allowed for project");
  if (request.operation && !project.allowedOperations.includes(request.operation)) {
    return result("reject", "operation not allowed for project");
  }
  if (request.flags.some((f) => NEEDS_APPROVAL.includes(f))) {
    return result("needs-approval", "stop and ask the owner", { lane: "mone" });
  }
  return result("route", "ok", { lane: request.lane, ledger: record("routed") });
}

module.exports = { LANES, parseRequest, validateProject, decide };
