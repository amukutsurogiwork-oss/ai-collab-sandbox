"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseRequest, validateProject, decide } = require("../src/router");

const registry = {
  projects: [{
    repo: "o/p", allowedLanes: ["chat", "codex", "mone"],
    allowedOperations: ["design", "pr-review"],
  }],
};
const req = (body, commentId = 1) => parseRequest(body, { repo: "o/p", commentId });

test("parses a request and ignores other comments", () => {
  const r = req("[MONE-REQUEST] id=A1 lane=chat sha=abc");
  assert.deepEqual([r.id, r.lane, r.status, r.sha], ["A1", "chat", "open", "abc"]);
  assert.equal(req("hello"), null);
});

test("routes a registered project to the requested lane", () => {
  const d = decide(req("[MONE-REQUEST] id=A1 lane=chat op=design"), registry);
  assert.equal(d.action, "route");
  assert.equal(d.lane, "chat");
});

test("new project works by registration only", () => {
  const reg = { projects: [...registry.projects, { repo: "o/new", allowedLanes: ["codex"], allowedOperations: [] }] };
  const r = parseRequest("[MONE-REQUEST] id=N1 lane=codex", { repo: "o/new", commentId: 9 });
  assert.equal(decide(r, reg).action, "route");
  assert.equal(decide(r, registry).action, "reject");
});

test("same comment or same request is not routed twice", () => {
  const first = decide(req("[MONE-REQUEST] id=A1 lane=chat", 1), registry);
  assert.equal(decide(req("[MONE-REQUEST] id=A1 lane=chat", 1), registry, first.ledger).action, "skip-duplicate");
  assert.equal(decide(req("[MONE-REQUEST] id=A1 lane=chat", 2), registry, first.ledger).action, "skip-duplicate");
});

test("cancel stops later routing", () => {
  const c = decide(req("[MONE-REQUEST] id=A1 status=cancel", 1), registry);
  assert.equal(c.action, "cancel");
  assert.equal(decide(req("[MONE-REQUEST] id=A1 lane=chat", 2), registry, c.ledger).action, "skip-cancelled");
});

test("work lane is refused unless the project allows it", () => {
  assert.equal(decide(req("[MONE-REQUEST] id=W1 lane=work"), registry).action, "reject");
});

test("paid, production, secrets and permission requests stop for approval", () => {
  const d = decide(req("[MONE-REQUEST] id=P1 lane=chat flags=paid"), registry);
  assert.equal(d.action, "needs-approval");
  assert.equal(d.ledger, undefined);
});

test("invalid registry entries are reported", () => {
  assert.ok(validateProject({ repo: "bad", allowedLanes: ["x"] }).length >= 2);
  assert.deepEqual(validateProject(registry.projects[0]), []);
});
