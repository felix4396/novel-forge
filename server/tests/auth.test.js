const test = require("node:test");
const assert = require("node:assert/strict");
const { createSessionToken, readSessionToken } = require("../dist/middleware/auth.js");

test("auth session accepts a valid signed token", () => {
  const secret = "a".repeat(32);
  const token = createSessionToken("admin", secret, 1_000_000);
  const session = readSessionToken(token, secret, 1_000_001);
  assert.equal(session?.username, "admin");
});

test("auth session rejects tampering and expiration", () => {
  const secret = "b".repeat(32);
  const token = createSessionToken("admin", secret, 1_000_000);
  assert.equal(readSessionToken(`${token}x`, secret, 1_000_001), null);
  assert.equal(readSessionToken(token, secret, 1_000_000 + 13 * 60 * 60 * 1000), null);
});
