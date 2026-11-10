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

/**
 * Rebuild state from the thread itself (GitHub is the source of truth).
 * Only markers inside comments written by the Actions bot are trusted.
 */
function stateFromComments(comments) {
  const ledger = {};
  const notices = new Set();
  for (const c of comments || []) {
    if (!c || !c.user || c.user.login !== BOT_LOGIN || c.user.type !== "Bot") continue;
    const m = MARK.exec(String(c.body || ""));
    if (!m) continue;
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }
    if (data.kind === "state" && typeof data.key === "string" && data.entry && Array.isArray(data.entry.commentIds)) {
      ledger[data.key] = data.entry;
    } else if (data.kind === "notice") {
      notices.add(`${data.commentId}|${data.reason}`);
    }
  }
  return { ledger, notices };
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
  const { ledger, notices } = stateFromComments(input.comments);
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
