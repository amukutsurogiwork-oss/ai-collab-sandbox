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
  parseRequest(body, { repo: "o/p", thread: 13, commentId, ...meta });

test("parses a request and ignores other comments", () => {
  const r = req("[MONE-REQUEST] id=A1 lane=chat op=design sha=abc");
  assert.deepEqual([r.id, r.lane, r.status, r.sha, r.operation], ["A1", "chat", "open", "abc", "design"]);
  assert.equal(req("hello"), null);
});

test("routes a registered project to the requested lane", () => {
  const d = decide(req("[MONE-REQUEST] id=A1 lane=chat op=design"), registry);
  assert.equal(d.action, "route");
  assert.equal(d.lane, "chat");
});

test("new project works by registration only", () => {
  const reg = { projects: [...registry.projects, { repo: "o/new", allowedLanes: ["codex"], allowedOperations: ["pr-review"] }] };
  const r = parseRequest("[MONE-REQUEST] id=N1 lane=codex op=pr-review", { repo: "o/new", thread: 1, commentId: 9 });
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
  const routed = decide(req("[MONE-REQUEST] id=G1 lane=codex op=pr-review sha=aaa", 1), registry);
  const r = req("[MONE-REQUEST] id=G1 lane=codex op=pr-review sha=aaa", 1);
  assert.equal(guardSideEffect(r, { ledger: routed.ledger, headSha: "aaa" }).ok, true);
  assert.equal(guardSideEffect(r, { ledger: routed.ledger, headSha: "bbb" }).reason, "stale sha");
  assert.equal(guardSideEffect(r, { ledger: routed.ledger }).reason, "head sha unknown");
  assert.equal(guardSideEffect(r, { ledger: routed.ledger, headSha: "aaa", alreadyPosted: true }).reason, "result already posted");
  const cancelled = decide(req("[MONE-REQUEST] id=G1 status=cancel", 2), registry, routed.ledger);
  assert.equal(guardSideEffect(r, { ledger: cancelled.ledger, headSha: "aaa" }).reason, "cancelled");
  assert.equal(guardSideEffect(r, { ledger: {}, headSha: "aaa" }).reason, "not routed");
});

test("invalid registry entries are reported", () => {
  assert.ok(validateProject({ repo: "bad", allowedLanes: ["x"] }).length >= 2);
  assert.deepEqual(validateProject(registry.projects[0]), []);
});
