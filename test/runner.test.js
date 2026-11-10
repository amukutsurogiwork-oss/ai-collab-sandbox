"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { listComments, run } = require("../scripts/intake");
const { BOT_LOGIN } = require("../src/intake");

const full = () => Array.from({ length: 100 }, (_, i) => ({ id: i + 1000, body: "", author_association: "NONE", user: { login: "u", id: 5, type: "User" } }));

test("listComments returns all comments when history fits", async () => {
  const pages = [full(), [full()[0]]];
  const got = await listComments(1, async (p) => pages[p - 1]);
  assert.strictEqual(got.length, 101);
});

test("listComments refuses to return truncated history (more than 1000 comments)", async () => {
  await assert.rejects(listComments(1, async () => full()), /E_HISTORY_TOO_LONG/);
});

test("listComments refuses exactly 1000 comments (cannot tell it from truncation)", async () => {
  await assert.rejects(listComments(1, async (p) => (p <= 10 ? full() : [])), /E_HISTORY_TOO_LONG/);
});

// ---- Regression tests for [AMU-REVIEW] on 4151501: re-check everything right before posting ----

const registry = { projects: [{ repo: "o/p", allowedLanes: ["chat", "codex"], allowedOperations: ["design", "pr-review"] }] };
const ownerUser = { login: "owner", id: 1, type: "User" };
const ask = (body = "[MONE-REQUEST] id=A1 lane=chat op=design") => ({ id: 7, body, author_association: "OWNER", user: ownerUser });
const SHA = "abc1234def5678abc1234def5678abc1234def56";

// A fake GitHub whose state can change between the first read and the re-check.
function fakeApi(steps) {
  let snap = -1; // each snapshot starts with getComment
  const posted = [];
  const now = () => steps[Math.min(Math.max(snap, 0), steps.length - 1)];
  return {
    posted,
    getComment: async () => { snap += 1; return now().comment; },
    listComments: async () => now().comments,
    getHeadSha: async () => now().headSha || null,
    postComment: async (n, body) => { posted.push(body); if (steps.failPost) throw new Error("boom"); },
  };
}
const event = (pr = false) => ({ issue: { number: 13, ...(pr ? { pull_request: {} } : {}) }, comment: { id: 7 }, repository: { owner: { id: 1 } } });
const go = (api, pr = false) => run({ event: event(pr), repo: "o/p", registry, api });

test("unchanged state posts exactly one comment", async () => {
  const s = { comment: ask(), comments: [ask()] };
  const api = fakeApi([s, s]);
  await go(api);
  assert.strictEqual(api.posted.length, 1);
  assert.match(api.posted[0], /^\[AMONE-ROUTED\] request=A1/);
});

test("a cancel comment that arrives after planning stops the post", async () => {
  const cancel = { id: 8, body: "[MONE-REQUEST] id=A1 status=cancel", author_association: "OWNER", user: ownerUser };
  const api = fakeApi([{ comment: ask(), comments: [ask()] }, { comment: ask(), comments: [ask(), cancel] }]);
  await go(api);
  assert.strictEqual(api.posted.length, 0);
});

test("a result that another run posted after planning stops the post", async () => {
  const first = fakeApi([{ comment: ask(), comments: [ask()] }, { comment: ask(), comments: [ask()] }]);
  await go(first);
  const botComment = { id: 50, body: first.posted[0], user: { login: BOT_LOGIN, type: "Bot" } };
  const api = fakeApi([{ comment: ask(), comments: [ask()] }, { comment: ask(), comments: [ask(), botComment] }]);
  await go(api);
  assert.strictEqual(api.posted.length, 0);
});

test("a push to the pull request after planning stops the post", async () => {
  const c = ask("[MONE-REQUEST] id=A1 lane=codex op=pr-review sha=abc1234");
  const api = fakeApi([{ comment: c, comments: [c], headSha: SHA }, { comment: c, comments: [c], headSha: "fff9999" + SHA.slice(7) }]);
  await go(api, true);
  assert.strictEqual(api.posted.length, 0);
});

test("an edited or re-authored request after planning stops the post", async () => {
  const edited = ask("[MONE-REQUEST] id=A1 lane=codex op=pr-review");
  const api = fakeApi([{ comment: ask(), comments: [ask()] }, { comment: edited, comments: [edited] }]);
  await go(api);
  assert.strictEqual(api.posted.length, 0);
});

test("a failed post is not retried", async () => {
  const s = { comment: ask(), comments: [ask()] };
  const steps = [s, s]; steps.failPost = true;
  const api = fakeApi(steps);
  await assert.rejects(go(api));
  assert.strictEqual(api.posted.length, 1);
});

// ---- Regression tests for [AMU-REVIEW] round=1 on 0ee352a ----

test("listComments stops when a history page is missing (404 -> null) or malformed", async () => {
  await assert.rejects(listComments(1, async (p) => (p === 1 ? full() : null)), /E_HISTORY_UNAVAILABLE/);
  await assert.rejects(listComments(1, async () => null), /E_HISTORY_UNAVAILABLE/);
  await assert.rejects(listComments(1, async () => ({ message: "x" })), /E_HISTORY_UNAVAILABLE/);
  assert.deepStrictEqual(await listComments(1, async () => []), []);
});

test("a missing second history page posts nothing", async () => {
  let snap = -1;
  const posted = [];
  const api = {
    getComment: async () => { snap += 1; return ask(); },
    listComments: (n) => listComments(n, async (p) => (p === 1 ? [ask(), ...full().slice(1)] : null)),
    getHeadSha: async () => null,
    postComment: async (n, b) => { posted.push(b); },
  };
  await assert.rejects(go(api), /E_HISTORY_UNAVAILABLE/);
  assert.strictEqual(posted.length, 0);
});

test("an edit below the first line between the two reads stops the post", async () => {
  const before = { ...ask("[MONE-REQUEST] id=A1 lane=chat op=design\nold"), updated_at: "t1" };
  const after = { ...ask("[MONE-REQUEST] id=A1 lane=chat op=design\nnew"), updated_at: "t2" };
  const api = fakeApi([{ comment: before, comments: [before] }, { comment: after, comments: [after] }]);
  await go(api);
  assert.strictEqual(api.posted.length, 0);
});

test("an unknown pull request head stops the run", async () => {
  const c = ask("[MONE-REQUEST] id=A1 lane=codex op=pr-review sha=abc1234");
  const api = fakeApi([{ comment: c, comments: [c], headSha: null }, { comment: c, comments: [c], headSha: null }]);
  await assert.rejects(go(api, true), /E_HEAD_UNKNOWN/);
  assert.strictEqual(api.posted.length, 0);
});

// ---- Regression tests for [AMU-REVIEW] round=2 on 2267e1b (fix cycle 3, approved) ----

test("a history page with a malformed comment stops the run", async () => {
  const good = { id: 1, body: "x", author_association: "NONE", user: { login: "a", id: 2, type: "User" } };
  for (const bad of [{ id: 3 }, { ...good, body: 5 }, { ...good, user: null }, { ...good, user: { login: "a", type: "User" } }, null]) {
    await assert.rejects(listComments(1, async () => [good, bad]), /E_HISTORY_MALFORMED/);
  }
  assert.strictEqual((await listComments(1, async () => [good])).length, 1);
});

test("a malformed history element never leads to a second routing notice", async () => {
  const first = fakeApi([{ comment: ask(), comments: [ask()] }, { comment: ask(), comments: [ask()] }]);
  await go(first);
  let snap = -1;
  const posted = [];
  const brokenBot = { id: 50, body: first.posted[0] }; // user missing
  const api = {
    getComment: async () => { snap += 1; return ask(); },
    listComments: (n) => listComments(n, async () => [ask(), brokenBot]),
    getHeadSha: async () => null,
    postComment: async (n, b) => { posted.push(b); },
  };
  await assert.rejects(go(api), /E_HISTORY_MALFORMED/);
  assert.strictEqual(posted.length, 0);
});

test("a pull request head that is not a 40-character hex SHA stops the run", async () => {
  const c = ask("[MONE-REQUEST] id=A1 lane=codex op=pr-review sha=abc1234");
  for (const bad of ["invalid", "abc1234", 12345, { sha: SHA }, SHA.toUpperCase() + "0"]) {
    const api = fakeApi([{ comment: c, comments: [c], headSha: bad }, { comment: c, comments: [c], headSha: bad }]);
    await assert.rejects(go(api, true), /E_HEAD_UNKNOWN/);
    assert.strictEqual(api.posted.length, 0);
  }
});
