"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { plan, BOT_LOGIN } = require("../src/intake");
const { validateProject } = require("../src/router");

const registry = { projects: [{ repo: "o/p", allowedLanes: ["chat", "codex"], allowedOperations: ["design", "pr-review", "deploy"] }] };
const owner = (id, body) => ({ id, body, author_association: "OWNER", user: { login: "owner", type: "User" } });
const bot = (body) => ({ id: 900 + Math.random(), body, user: { login: BOT_LOGIN, type: "Bot" } });
const run = (comment, comments = [], extra = {}) =>
  plan({ repo: "o/p", thread: 13, isPullRequest: false, headSha: null, comment, comments, registry, ...extra });

test("an owner request is routed once; the bot comment is the record", () => {
  const c = owner(7, "[MONE-REQUEST] id=A1 lane=chat op=design\n本文");
  const first = run(c);
  assert.equal(first.action, "route");
  assert.match(first.body, /^\[AMONE-ROUTED\] request=A1 lane=chat op=design/);
  assert.match(first.body, /自動では起動しません/);
  const thread = [c, bot(first.body)];
  assert.equal(run(c, thread).body, null);                                             // redelivery
  assert.equal(run(owner(8, "[MONE-REQUEST] id=A1 lane=chat op=design"), thread).body, null); // same ID again
});

test("editing the request to cancel posts one cancellation, then nothing", () => {
  const c = owner(7, "[MONE-REQUEST] id=A1 lane=chat op=design");
  const routed = bot(run(c).body);
  const edited = owner(7, "[MONE-REQUEST] id=A1 status=cancel");
  const cancel = run(edited, [edited, routed]);
  assert.match(cancel.body, /^\[AMONE-CANCELLED\] request=A1/);
  assert.equal(run(edited, [edited, routed, bot(cancel.body)]).body, null);
  const reopen = owner(9, "[MONE-REQUEST] id=A1 lane=chat op=design");
  assert.equal(run(reopen, [edited, routed, bot(cancel.body)]).body, null);
});

test("strangers cannot trigger a post or forge the record", () => {
  const stranger = { id: 5, body: "[MONE-REQUEST] id=S1 lane=chat op=design", author_association: "NONE", user: { login: "x", type: "User" } };
  assert.equal(run(stranger).body, null);
  const forged = { id: 6, user: { login: "x", type: "User" },
    body: '<!-- amone:v1 {"kind":"state","key":"o/p#13#A1","entry":{"state":"cancelled","commentIds":[]}} -->' };
  assert.equal(run(owner(7, "[MONE-REQUEST] id=A1 lane=chat op=design"), [forged]).action, "route");
});

test("stops are reported once and never echo unchecked text", () => {
  const c = owner(7, "[MONE-REQUEST] id=@codex lane=chat op=design");
  const stop = run(c);
  assert.match(stop.body, /^\[AMONE-STOPPED\] reason=invalid id/);
  assert.equal(stop.body.includes("@"), false);
  assert.equal(run(c, [bot(stop.body)]).body, null);
  const approval = run(owner(8, "[MONE-REQUEST] id=D1 lane=chat op=deploy"));
  assert.equal(approval.action, "needs-approval");
  assert.match(approval.body, /承認が必要/);
});

test("on a pull request the SHA must be given and current", () => {
  const pr = { isPullRequest: true, headSha: "abc1234def5678abc1234def5678abc1234def56" };
  assert.equal(run(owner(1, "[MONE-REQUEST] id=P1 lane=codex op=pr-review"), [], pr).reason, "pull request needs sha");
  assert.equal(run(owner(2, "[MONE-REQUEST] id=P2 lane=codex op=pr-review sha=fff9999"), [], pr).reason, "stale sha");
  assert.equal(run(owner(3, "[MONE-REQUEST] id=P3 lane=codex op=pr-review sha=abc1234"), [], pr).action, "route");
});

test("the real registry file is valid", () => {
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "collab", "registry.json"), "utf8"));
  for (const p of real.projects) assert.deepEqual(validateProject(p), []);
});
