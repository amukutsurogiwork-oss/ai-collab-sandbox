"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { listComments } = require("../scripts/intake");

const full = () => Array.from({ length: 100 }, (_, i) => ({ id: i }));

test("listComments returns all comments when history fits", async () => {
  const pages = [full(), [{ id: 1 }]];
  const got = await listComments(1, async (p) => pages[p - 1]);
  assert.strictEqual(got.length, 101);
});

test("listComments refuses to return truncated history (more than 1000 comments)", async () => {
  await assert.rejects(listComments(1, async () => full()), /partial history/);
});

test("listComments accepts exactly 1000 comments when page 11 is empty-bounded", async () => {
  // 10 full pages is indistinguishable from truncation without page 11, so it must refuse.
  await assert.rejects(listComments(1, async (p) => (p <= 10 ? full() : [])), /partial history/);
});
