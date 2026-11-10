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

// ---- Regression tests for [AMU-REVIEW] on 4151501 ----

test("a cancel comment by the owner blocks routing even before it was processed", () => {
  const ask = owner(7, "[MONE-REQUEST] id=A1 lane=chat op=design");
  const cancel = owner(8, "[MONE-REQUEST] id=A1 status=cancel");
  const r = run(ask, [ask, cancel]);
  assert.equal(r.body, null);
  assert.equal(r.reason, "cancel comment present");
  const fake = { id: 9, body: "[MONE-REQUEST] id=A1 status=cancel", author_association: "NONE", user: { login: "x", id: 99, type: "User" } };
  assert.equal(run(ask, [ask, fake]).action, "route");
});

test("the author must be the repository owner by ID, not only by association", () => {
  const c = { id: 7, body: "[MONE-REQUEST] id=A1 lane=chat op=design", author_association: "OWNER", user: { login: "other", id: 2, type: "User" } };
  assert.equal(run(c, [], { ownerId: 1 }).body, null);
  assert.equal(run({ ...c, user: { login: "owner", id: 1, type: "User" } }, [], { ownerId: 1 }).action, "route");
});

// ---- A bot record that was edited and no longer parses must not be skipped ----

test("a broken bot record stops instead of being silently skipped", () => {
  const c = owner(7, "[MONE-REQUEST] id=A1 lane=chat op=design");
  const routed = run(c).body;
  for (const broken of [
    routed.replace(/<!-- amone:v1 \{/, "<!-- amone:v1 {{"),                 // JSON broken
    routed.replace('"kind":"state"', '"kind":"stat"'),                      // unknown kind
    routed.replace(/"commentIds":\[[^\]]*\]/, '"commentIds":"7"'),         // wrong shape
  ]) {
    const r = run(owner(8, "[MONE-REQUEST] id=A1 lane=chat op=design"), [c, bot(broken)]);
    assert.equal(r.body, null);
    assert.equal(r.reason, "broken bot record");
  }
  // a bot comment without any marker is just ignored
  assert.equal(run(c, [bot("hello")]).action, "route");
});

// ---- Regression tests for [AMU-REVIEW] round=3 and Codex P2 on 48f5207 ----

test("every way of corrupting a bot record halts instead of allowing a second acceptance", () => {
  const c = owner(7, "[MONE-REQUEST] id=A1 lane=chat op=design");
  const routed = run(c).body;
  const again = owner(8, "[MONE-REQUEST] id=A1 lane=chat op=design");
  const cases = {
    "unknown state": routed.replace('"state":"routed"', '"state":"route"'),
    "empty commentIds": routed.replace(/"commentIds":\[[^\]]*\]/, '"commentIds":[]'),
    "routed without lane": routed.replace(/"lane":"chat",?/, ""),
    "key of another thread": routed.replace('"o/p#13#A1"', '"o/p#99#A1"'),
    "key that is not a key": routed.replace('"o/p#13#A1"', '"A1"'),
    "marker removed, prefix kept": routed.replace(/\n\n<!-- amone:v1 .* -->/, ""),
    "two markers": `${routed}\n${routed.slice(routed.indexOf("<!--"))}`,
    "notice with a non-numeric commentId": "[AMONE-STOPPED] reason=x\n\n<!-- amone:v1 {\"kind\":\"notice\",\"commentId\":\"abc\",\"reason\":\"x\"} -->",
  };
  for (const [name, broken] of Object.entries(cases)) {
    assert.notEqual(broken, routed, name);
    const r = run(again, [c, bot(broken)]);
    assert.equal(r.body, null, name);
    assert.equal(r.reason, "broken bot record", name);
  }
});

test("a valid record still blocks a second acceptance, and unrelated bot comments are ignored", () => {
  const c = owner(7, "[MONE-REQUEST] id=A1 lane=chat op=design");
  const routed = run(c).body;
  assert.equal(run(owner(8, "[MONE-REQUEST] id=A1 lane=chat op=design"), [c, bot(routed)]).action, "skip-duplicate");
  assert.equal(run(c, [bot("unit tests passed")]).action, "route");
});

// ---- Regression tests for [AMU-REVIEW] round=4 on 79db813: visible text and record must agree ----

test("a record whose hidden data disagrees with its visible text halts", () => {
  const c = owner(7, "[MONE-REQUEST] id=A1 lane=chat op=design");
  const routed = run(c).body;
  const cancelBody = run(owner(9, "[MONE-REQUEST] id=C1 status=cancel")).body;
  const stopBody = run(owner(10, "[MONE-REQUEST] id=@x lane=chat op=design")).body;
  const again = owner(8, "[MONE-REQUEST] id=A1 lane=chat op=design");
  const cases = {
    "key A1 -> B1 only in the record": routed.replace('"o/p#13#A1"', '"o/p#13#B1"'),
    "ROUTED text with a notice record": routed.replace(/<!-- amone:v1 .* -->/, '<!-- amone:v1 {"kind":"notice","commentId":"7","reason":"x"} -->'),
    "visible lane changed": routed.replace("lane=chat op=design", "lane=codex op=design"),
    "visible text edited below the first line": routed.replace("受け付けました。", "受け付けた。"),
    "CANCELLED text with a routed record": cancelBody.replace('"state":"cancelled"', '"state":"routed","lane":"chat","operation":"design"'),
    "STOPPED reason changed in the text": stopBody.replace("reason=invalid id", "reason=other"),
    "extra field in the record": routed.replace('"state":"routed"', '"state":"routed","extra":1'),
    "flags not in normalized form": routed.replace('"flags":""', '"flags":"b,a"'),
  };
  for (const [name, broken] of Object.entries(cases)) {
    assert.notEqual(broken, routed, name);
    const r = run(again, [c, bot(broken)]);
    assert.equal(r.reason, "broken bot record", name);
    assert.equal(r.body, null, name);
  }
});

test("every comment the intake writes is read back as a valid record", () => {
  const c = owner(7, "[MONE-REQUEST] id=A1 lane=chat op=design");
  const routed = run(c).body;
  const edit = owner(7, "[MONE-REQUEST] id=A1 status=cancel");
  const cancelled = run(edit, [edit, bot(routed)]).body;
  const freshCancel = run(owner(9, "[MONE-REQUEST] id=C1 status=cancel")).body;
  const stopped = run(owner(10, "[MONE-REQUEST] id=@x lane=chat op=design")).body;
  const approval = run(owner(11, "[MONE-REQUEST] id=D1 lane=chat op=deploy")).body;
  const flagged = run(owner(12, "[MONE-REQUEST] id=F1 lane=chat op=design flags=note,alpha")).body;
  for (const body of [routed, cancelled, freshCancel, stopped, approval, flagged]) {
    assert.ok(body, "the intake should have written something");
    const r = run(owner(20, "[MONE-REQUEST] id=Z9 lane=chat op=design"), [bot(body)]);
    assert.notEqual(r.reason, "broken bot record", body.split("\n")[0]);
  }
  // Windows line endings returned by an API must not count as tampering.
  const r = run(owner(8, "[MONE-REQUEST] id=A1 lane=chat op=design"), [c, bot(routed.replace(/\n/g, "\r\n"))]);
  assert.equal(r.action, "skip-duplicate");
});

test("every stop reason the router can give is read back as a valid notice", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "router.js"), "utf8");
  const reasons = [...src.matchAll(/result\("(?:reject|needs-approval)", "([^"]+)"/g)].map((m) => m[1]);
  reasons.push("pull request needs sha", "stale sha");
  assert.ok(reasons.includes("work lane needs a GUI operation"));
  const { stateFromComments, renderNotice } = require("../src/intake");
  for (const reason of reasons) {
    for (const stop of ["reject", "approval"]) {
      const body = renderNotice({ kind: "notice", commentId: "7", reason, stop });
      const st = stateFromComments([bot(body)], "o/p#13#");
      assert.equal(st.broken, false, reason);
      assert.ok(st.notices.has(`7|${reason}`), reason);
    }
  }
});

// ---- Regression tests for [AMU-REVIEW] round=5 on 061a1c8: no hidden-only fields ----

test("changing a field that only lived inside the record halts", () => {
  const pr = { isPullRequest: true, headSha: "abc1234def5678abc1234def5678abc1234def56" };
  const c = owner(7, "[MONE-REQUEST] id=A1 lane=codex op=pr-review sha=abc1234 flags=note");
  const routed = run(c, [], pr).body;
  assert.ok(routed, "should route");
  const stop = run(owner(10, "[MONE-REQUEST] id=@x lane=chat op=design")).body;
  const again = owner(8, "[MONE-REQUEST] id=A1 lane=codex op=pr-review sha=abc1234");
  const cases = {
    "commentIds 7 -> 8": routed.replace('"commentIds":["7"]', '"commentIds":["8"]'),
    "sha changed": routed.replace('"sha":"abc1234"', '"sha":"fff9999"'),
    "flags changed": routed.replace('"flags":"note"', '"flags":"other"'),
    "notice commentId changed": stop.replace('"commentId":"10"', '"commentId":"11"'),
  };
  for (const [name, broken] of Object.entries(cases)) {
    assert.notEqual(broken, name === "notice commentId changed" ? stop : routed, name);
    const r = run(again, [c, bot(broken)], pr);
    assert.equal(r.reason, "broken bot record", name);
    assert.equal(r.body, null, name);
  }
});

test("the original request edited to another ID after routing is not accepted again", () => {
  const c = owner(7, "[MONE-REQUEST] id=A1 lane=chat op=design");
  const routed = run(c).body;
  const edited = owner(7, "[MONE-REQUEST] id=B1 lane=chat op=design");
  const r = run(edited, [edited, bot(routed)]);
  assert.equal(r.action, "reject");
  assert.equal(r.reason, "comment already bound to another request");
  assert.doesNotMatch(r.body, /AMONE-ROUTED/);
});
