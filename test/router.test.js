"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseRequest, validateProject, decide, guardSideEffect } = require("../src/router");

const registry = {
  projects: [{
    repo: "o/p", allowedLanes: ["chat", "codex", "mone"],
    allowedOperations: ["design", "pr-review", "deploy"],
    approvalRequired: ["deploy"],
  }],
};
const req = (body, commentId = 1, meta = {}) =>
  parseRequest(body, { repo: "o/p", thread: 13, commentId, trusted: true, ...meta });

test("parses a request and ignores other comments", () => {
  const r = req("[MONE-REQUEST] id=A1 lane=chat op=design sha=abc1234");
  assert.deepEqual([r.id, r.lane, r.status, r.sha, r.operation], ["A1", "chat", "open", "abc1234", "design"]);
  assert.equal(req("hello"), null);
});

test("routes a registered project to the requested lane", () => {
  const d = decide(req("[MONE-REQUEST] id=A1 lane=chat op=design"), registry);
  assert.equal(d.action, "route");
  assert.equal(d.lane, "chat");
});

test("new project works by registration only", () => {
  const reg = { projects: [...registry.projects, { repo: "o/new", allowedLanes: ["codex"], allowedOperations: ["pr-review"] }] };
  const r = parseRequest("[MONE-REQUEST] id=N1 lane=codex op=pr-review", { repo: "o/new", thread: 1, commentId: 9, trusted: true });
  assert.equal(decide(r, reg).action, "route");
  assert.equal(decide(r, registry).action, "reject");
});

test("unknown status and missing operation are rejected", () => {
  assert.equal(decide(req("[MONE-REQUEST] id=S1 lane=chat op=design status=done"), registry).reason, "unknown status");
  assert.equal(decide(req("[MONE-REQUEST] id=S2 lane=chat"), registry).reason, "operation missing");
});

test("same comment or same request is not routed twice", () => {
  const first = decide(req("[MONE-REQUEST] id=A1 lane=chat op=design", 1), registry);
  assert.equal(decide(req("[MONE-REQUEST] id=A1 lane=chat op=design", 1), registry, first.ledger).action, "skip-duplicate");
  assert.equal(decide(req("[MONE-REQUEST] id=A1 lane=chat op=design", 2), registry, first.ledger).action, "skip-duplicate");
});

test("same request ID in another repo or thread is a separate request", () => {
  const reg = { projects: [...registry.projects, { repo: "o/q", allowedLanes: ["chat"], allowedOperations: ["design"] }] };
  const first = decide(req("[MONE-REQUEST] id=A1 lane=chat op=design"), reg);
  const otherRepo = req("[MONE-REQUEST] id=A1 lane=chat op=design", 5, { repo: "o/q" });
  const otherThread = req("[MONE-REQUEST] id=A1 lane=chat op=design", 6, { thread: 99 });
  assert.equal(decide(otherRepo, reg, first.ledger).action, "route");
  assert.equal(decide(otherThread, reg, first.ledger).action, "route");
});

test("cancel wins, before or after routing", () => {
  const c = decide(req("[MONE-REQUEST] id=A1 status=cancel", 1), registry);
  assert.equal(c.action, "cancel");
  assert.equal(decide(req("[MONE-REQUEST] id=A1 lane=chat op=design", 2), registry, c.ledger).action, "skip-cancelled");

  const routed = decide(req("[MONE-REQUEST] id=B1 lane=chat op=design", 3), registry);
  const late = decide(req("[MONE-REQUEST] id=B1 status=cancel", 4), registry, routed.ledger);
  assert.equal(late.action, "cancel");
  assert.equal(late.ledger["o/p#13#B1"].state, "cancelled");
});

test("work lane is refused unless the project allows it", () => {
  assert.equal(decide(req("[MONE-REQUEST] id=W1 lane=work op=design"), registry).action, "reject");
});

test("approval comes from the registry, not from the comment text", () => {
  const d = decide(req("[MONE-REQUEST] id=P1 lane=chat op=deploy approved=yes"), registry);
  assert.equal(d.action, "needs-approval");
  assert.equal(d.ledger, undefined);
  assert.equal(decide(req("[MONE-REQUEST] id=P2 lane=chat op=design flags=paid"), registry).action, "needs-approval");
});

test("guard stops a side effect on cancel, repeat post or stale SHA", () => {
  const routed = decide(req("[MONE-REQUEST] id=G1 lane=codex op=pr-review sha=aaaaaaa", 1), registry);
  const r = req("[MONE-REQUEST] id=G1 lane=codex op=pr-review sha=aaaaaaa", 1);
  assert.equal(guardSideEffect(r, { ledger: routed.ledger, headSha: "aaaaaaa", isPullRequest: true }).ok, true);
  assert.equal(guardSideEffect(r, { ledger: routed.ledger, headSha: "bbbbbbb", isPullRequest: true }).reason, "stale sha");
  assert.equal(guardSideEffect(r, { ledger: routed.ledger, isPullRequest: true }).reason, "head sha unknown");
  assert.equal(guardSideEffect(r, { ledger: routed.ledger, headSha: "aaaaaaa", isPullRequest: true, alreadyPosted: true }).reason, "result already posted");
  const cancelled = decide(req("[MONE-REQUEST] id=G1 status=cancel", 2), registry, routed.ledger);
  assert.equal(guardSideEffect(r, { ledger: cancelled.ledger, headSha: "aaaaaaa", isPullRequest: true }).reason, "cancelled");
  assert.equal(guardSideEffect(r, { ledger: {}, headSha: "aaaaaaa", isPullRequest: true }).reason, "not routed");
});

test("invalid registry entries are reported", () => {
  assert.ok(validateProject({ repo: "bad", allowedLanes: ["x"] }).length >= 2);
  assert.deepEqual(validateProject(registry.projects[0]), []);
});

// ---- Regression tests for review findings on bad0e75 ----

test("editing the routed comment to status=cancel still cancels", () => {
  const routed = decide(req("[MONE-REQUEST] id=E1 lane=chat op=design", 7), registry);
  const edited = decide(req("[MONE-REQUEST] id=E1 status=cancel", 7), registry, routed.ledger);
  assert.equal(edited.action, "cancel");
  assert.equal(edited.ledger["o/p#13#E1"].state, "cancelled");
  const again = decide(req("[MONE-REQUEST] id=E1 status=cancel", 7), registry, edited.ledger);
  assert.equal(again.action, "skip-cancelled");
});

test("sensitive operations stop even if the registry forgot approvalRequired", () => {
  const reg = { projects: [{ repo: "o/p", allowedLanes: ["chat"], allowedOperations: ["production", "deploy", "secrets"] }] };
  for (const op of ["production", "deploy", "secrets"]) {
    assert.equal(decide(req(`[MONE-REQUEST] id=X-${op} lane=chat op=${op}`), reg).action, "needs-approval", op);
  }
});

test("work lane needs an operation registered as GUI work", () => {
  const reg = { projects: [{ repo: "o/p", allowedLanes: ["work"], allowedOperations: ["design", "screen-check"], guiOperations: ["screen-check"] }] };
  assert.equal(decide(req("[MONE-REQUEST] id=W2 lane=work op=design"), reg).reason, "work lane needs a GUI operation");
  assert.equal(decide(req("[MONE-REQUEST] id=W3 lane=work op=screen-check"), reg).action, "route");
});

test("guard only passes the exact routed request", () => {
  const routed = decide(req("[MONE-REQUEST] id=G2 lane=chat op=design sha=aaaaaaa", 1), registry);
  const swapped = req("[MONE-REQUEST] id=G2 lane=chat op=pr-review sha=aaaaaaa", 1);
  assert.equal(guardSideEffect(swapped, { ledger: routed.ledger, headSha: "aaaaaaa", isPullRequest: true }).reason, "request changed");
  const toDeploy = req("[MONE-REQUEST] id=G2 lane=chat op=deploy sha=aaaaaaa", 1);
  assert.equal(guardSideEffect(toDeploy, { ledger: routed.ledger, headSha: "aaaaaaa", isPullRequest: true }).reason, "needs approval");
  const otherSha = req("[MONE-REQUEST] id=G2 lane=chat op=design sha=bbbbbbb", 1);
  assert.equal(guardSideEffect(otherSha, { ledger: routed.ledger, headSha: "bbbbbbb", isPullRequest: true }).reason, "request changed");
  const fakeState = { "o/p#13#G2": { ...routed.ledger["o/p#13#G2"], state: "needs-approval" } };
  const r = req("[MONE-REQUEST] id=G2 lane=chat op=design sha=aaaaaaa", 1);
  assert.equal(guardSideEffect(r, { ledger: fakeState, headSha: "aaaaaaa", isPullRequest: true }).reason, "not routed");
});

test("guard requires a SHA for pull request side effects", () => {
  const routed = decide(req("[MONE-REQUEST] id=G3 lane=codex op=pr-review", 1), registry);
  const r = req("[MONE-REQUEST] id=G3 lane=codex op=pr-review", 1);
  assert.equal(guardSideEffect(r, { ledger: routed.ledger, headSha: "aaaaaaa", isPullRequest: true }).reason, "pull request needs sha");
});

test("missing thread or unsafe IDs are rejected", () => {
  const noThread = parseRequest("[MONE-REQUEST] id=K1 lane=chat op=design", { repo: "o/p", commentId: 1, trusted: true });
  assert.equal(decide(noThread, registry).reason, "invalid thread");
  assert.equal(decide(req("[MONE-REQUEST] id=K1 lane=chat op=design", 1, { thread: "13#x" }), registry).reason, "invalid thread");
  assert.equal(decide(req("[MONE-REQUEST] id=K#1 lane=chat op=design"), registry).reason, "invalid id");
});

// ---- Regression tests for round-2 review findings on d1710b5 ----

test("adding a sensitive flag by editing a routed comment is stopped by the guard", () => {
  const routed = decide(req("[MONE-REQUEST] id=F1 lane=chat op=design sha=aaaaaaa", 3), registry);
  const edited = req("[MONE-REQUEST] id=F1 lane=chat op=design sha=aaaaaaa flags=production", 3);
  assert.equal(decide(edited, registry, routed.ledger).action, "skip-duplicate");
  const g = guardSideEffect(edited, { ledger: routed.ledger, headSha: "aaaaaaa", isPullRequest: true });
  assert.equal(g.ok, false);
  assert.equal(g.reason, "needs approval");
  // any flag change at all (even order or a harmless flag) means the request changed
  const harmless = req("[MONE-REQUEST] id=F1 lane=chat op=design sha=aaaaaaa flags=note", 3);
  assert.equal(guardSideEffect(harmless, { ledger: routed.ledger, headSha: "aaaaaaa", isPullRequest: true }).reason, "request changed");
});

test("changing the request ID of an already routed comment does not route a second request", () => {
  const routed = decide(req("[MONE-REQUEST] id=A1 lane=chat op=design", 7), registry);
  const renamed = decide(req("[MONE-REQUEST] id=A2 lane=chat op=design", 7), registry, routed.ledger);
  assert.equal(renamed.action, "reject");
  assert.equal(renamed.reason, "comment already bound to another request");
  assert.equal(renamed.ledger, undefined);
  // a different comment with the same ID is still a duplicate request; a different thread is fine
  assert.equal(decide(req("[MONE-REQUEST] id=A1 lane=chat op=design", 8), registry, routed.ledger).action, "skip-duplicate");
  assert.equal(decide(req("[MONE-REQUEST] id=A2 lane=chat op=design", 7, { thread: 99 }), registry, routed.ledger).action, "route");
});

test("guard rejects a cancel request and an unknown target type", () => {
  const routed = decide(req("[MONE-REQUEST] id=H1 lane=codex op=pr-review sha=aaaaaaa", 1), registry);
  const cancelNow = req("[MONE-REQUEST] id=H1 lane=codex op=pr-review sha=aaaaaaa status=cancel", 1);
  assert.equal(guardSideEffect(cancelNow, { ledger: routed.ledger, headSha: "aaaaaaa", isPullRequest: true }).reason, "request is not open");
  const r = req("[MONE-REQUEST] id=H1 lane=codex op=pr-review sha=aaaaaaa", 1);
  assert.equal(guardSideEffect(r, { ledger: routed.ledger, headSha: "aaaaaaa" }).reason, "target type unknown");
  assert.equal(guardSideEffect(r, { ledger: routed.ledger, headSha: "aaaaaaa", isPullRequest: true }).ok, true);
});

test("registry validation checks list types and guiOperations", () => {
  const base = { repo: "o/p", allowedLanes: ["work"], allowedOperations: ["design", "screen-check"] };
  assert.ok(validateProject({ ...base, guiOperations: "screen-check" }).length > 0);
  assert.ok(validateProject({ ...base, guiOperations: [1] }).length > 0);
  assert.ok(validateProject({ ...base, guiOperations: ["unlisted-op"] }).length > 0);
  assert.ok(validateProject({ ...base, allowedOperations: "design" }).length > 0);
  assert.ok(validateProject({ ...base, approvalRequired: "deploy" }).length > 0);
  assert.deepEqual(validateProject({ ...base, guiOperations: ["screen-check"] }), []);
  const reg = { projects: [{ ...base, guiOperations: "screen-check" }] };
  assert.equal(decide(req("[MONE-REQUEST] id=V1 lane=work op=check"), reg).reason, "registry entry invalid");
});

// ---- Author check (public repo: anyone can comment) ----

test("requests from anyone but the repository owner are ignored", () => {
  const stranger = req("[MONE-REQUEST] id=U1 lane=chat op=design", 1, { trusted: false });
  const d = decide(stranger, registry);
  assert.equal(d.action, "ignore-untrusted");
  assert.equal(d.ledger, undefined);
  const routed = decide(req("[MONE-REQUEST] id=U1 lane=chat op=design", 1), registry);
  assert.equal(guardSideEffect(stranger, { ledger: routed.ledger, isPullRequest: false }).ok, false);
  const strangerCancel = req("[MONE-REQUEST] id=U1 status=cancel", 2, { trusted: false });
  assert.equal(decide(strangerCancel, registry, routed.ledger).action, "ignore-untrusted");
});

test("unsafe sha or flags are rejected, short and full SHA match", () => {
  assert.equal(decide(req("[MONE-REQUEST] id=Z1 lane=chat op=design sha=-->"), registry).reason, "invalid sha");
  assert.equal(decide(req("[MONE-REQUEST] id=Z2 lane=chat op=design flags=@x"), registry).reason, "invalid flags");
  const { sameSha } = require("../src/router");
  assert.equal(sameSha("abc1234", "abc1234def5678"), true);
  assert.equal(sameSha("abc1234", "abc9999def5678"), false);
  assert.equal(sameSha("abc", "abc1234"), false);
});
