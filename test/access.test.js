"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { canReadDocument } = require("../src/access");

test("anyone can read a public document", () => {
  assert.equal(canReadDocument(null, {
    ownerId: "user-a", isPublic: true,
  }), true);
});

test("the owner can read their private document", () => {
  assert.equal(canReadDocument({ id: "user-a" }, {
    ownerId: "user-a", isPublic: false,
  }), true);
});

test("an anonymous visitor cannot read a private document", () => {
  assert.equal(canReadDocument(null, {
    ownerId: "user-a", isPublic: false,
  }), false);
});

test("a missing document is denied", () => {
  assert.equal(canReadDocument({ id: "user-a" }, null), false);
});
