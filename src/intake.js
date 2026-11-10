"use strict";

const { parseRequest, requestKey, decide, sameSha } = require("./router");

const BOT_LOGIN = "github-actions[bot]";
const MARK = /<!-- amone:v1 (.+?) -->/;

const LANE_NOTES = {
  chat: "担当: アムChat。アムChatは自動では起動しません。よしひろさんがアムに、この依頼を見るよう伝えてください。",
  work: "担当: アムWork(画面操作)。アムは自動では起動しません。よしひろさんがアムに、この依頼を見るよう伝えてください。",
  codex: "担当: CodexのPRレビュー。モネがこのPRでレビューを頼みます。",
  mone: "担当: モネ。",
};

function marker(data) {
  return `<!-- amone:v1 ${JSON.stringify(data)} -->`;
}

const STATES = ["routed", "cancelled"];
const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const NUM = /^[1-9][0-9]*$/;
const HEX = /^[0-9a-f]{7,40}$/;

/** Exactly the ledger entry shapes that decide() writes. Anything else is broken. */
function isValidEntry(e) {
  if (!e || typeof e !== "object" || !STATES.includes(e.state)) return false;
  if (!Array.isArray(e.commentIds) || e.commentIds.length === 0) return false;
  if (!e.commentIds.every((x) => typeof x === "string" && NUM.test(x))) return false;
  const optional = (v, ok) => v === undefined || ok(v);
  const fieldsOk = optional(e.lane, (v) => typeof v === "string" && SAFE_ID.test(v))
    && optional(e.operation, (v) => typeof v === "string" && SAFE_ID.test(v))
    && optional(e.sha, (v) => v === null || (typeof v === "string" && HEX.test(v)))
    && optional(e.flags, (v) => typeof v === "string");
  if (!fieldsOk) return false;
  // A routed entry always carries what it was routed for.
  return e.state !== "routed" || (typeof e.lane === "string" && typeof e.operation === "string");
}

/**
 * Rebuild state from the thread itself (GitHub is the source of truth).
 * Only comments written by the Actions bot are considered. A bot comment that
 * looks like ours (marker or "[AMONE-" prefix) must be read exactly; otherwise
 * the history is unknown and `broken` is set (never skipped silently).
 * `prefix` is "<repo>#<thread>#": records for any other place are broken.
 */
function stateFromComments(comments, prefix) {
  const ledger = {};
  const notices = new Set();
  let broken = false;
  for (const c of comments || []) {
    if (!c || !c.user || c.user.login !== BOT_LOGIN || c.user.type !== "Bot") continue;
    const text = String(c.body || "");
    const markers = text.split("<!-- amone:v1").length - 1;
    if (markers === 0 && !text.trimStart().startsWith("[AMONE-")) continue; // not ours
    if (markers !== 1) { broken = true; continue; }
    const m = MARK.exec(text);
    let data = null;
    if (m) { try { data = JSON.parse(m[1]); } catch { data = null; } }
    const keyOk = (k) => typeof k === "string" && k.startsWith(prefix) && SAFE_ID.test(k.slice(prefix.length));
    if (data && data.kind === "state" && keyOk(data.key) && isValidEntry(data.entry)) {
      ledger[data.key] = data.entry;
    } else if (data && data.kind === "notice" && typeof data.commentId === "string" && NUM.test(data.commentId)
        && typeof data.reason === "string" && data.reason.length > 0) {
      notices.add(`${data.commentId}|${data.reason}`);
    } else {
      broken = true;
    }
  }
  return { ledger, notices, broken };
}

/**
 * Decide what the intake workflow should post for one comment event.
 * Pure function. Returns { action, reason, body } where body is the single
 * comment to post, or null when nothing must be posted.
 * Text from the request is echoed only after the router validated it.
 */
function plan(input) {
  const { repo, thread, comment, registry } = input;
  // Owner = GitHub says OWNER and, when the caller knows it, the same account ID.
  const isOwner = (c) => Boolean(c) && c.author_association === "OWNER"
    && (input.ownerId == null || Boolean(c.user && c.user.id === input.ownerId));
  const parse = (c) => parseRequest(c.body, { repo, thread, commentId: c.id, trusted: isOwner(c) });

  const request = parse(comment);
  const { ledger, notices, broken } = stateFromComments(input.comments, `${repo}#${thread}#`);
  if (broken) return { action: "halt", reason: "broken bot record", body: null };
  let d = decide(request, registry, ledger);

  // Cancel wins even when the cancel comment has not been processed yet: any
  // owner comment in the thread that cancels this request blocks routing.
  if (d.action === "route") {
    const key = requestKey(request);
    const cancelled = (input.comments || []).some((c) => {
      if (!c || String(c.id) === String(comment.id)) return false;
      const other = parse(c);
      return Boolean(other) && other.trusted && other.status === "cancel" && requestKey(other) === key;
    });
    if (cancelled) return { action: "skip-cancelled", reason: "cancel comment present", body: null };
  }

  if (d.action === "route" && input.isPullRequest) {
    if (!request.sha) d = { action: "reject", reason: "pull request needs sha" };
    else if (!sameSha(request.sha, input.headSha)) d = { action: "reject", reason: "stale sha" };
  }

  if (d.action === "route" || d.action === "cancel") {
    const key = requestKey(request);
    const state = marker({ kind: "state", key, entry: d.ledger[key] });
    const text = d.action === "route"
      ? `[AMONE-ROUTED] request=${request.id} lane=${d.lane} op=${request.operation}\n受け付けました。${LANE_NOTES[d.lane]}`
      : `[AMONE-CANCELLED] request=${request.id}\n取り消しました。この依頼は実行しません。`;
    return { action: d.action, reason: d.reason, body: `${text}\n\n${state}` };
  }

  if (d.action === "reject" || d.action === "needs-approval") {
    const commentId = String(comment.id);
    if (notices.has(`${commentId}|${d.reason}`)) return { action: d.action, reason: d.reason, body: null };
    const text = d.action === "needs-approval"
      ? "よしひろさんの承認が必要な操作なので、止めました。"
      : "この依頼は受け付けませんでした。";
    const note = marker({ kind: "notice", commentId, reason: d.reason });
    return { action: d.action, reason: d.reason, body: `[AMONE-STOPPED] reason=${d.reason}\n${text}\n\n${note}` };
  }

  return { action: d.action, reason: d.reason, body: null };
}

module.exports = { plan, stateFromComments, BOT_LOGIN };
