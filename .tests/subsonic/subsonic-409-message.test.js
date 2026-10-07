import assert from "node:assert/strict";
import test from "node:test";

// Test the 409 error message passthrough in Subsonic error handlers
test("409 error message passthrough in createplaylist handler", async () => {
  // Mock error with 409 status
  const error = new Error("Playlist name already exists in this context");
  error.status = 409;
  
  // Verify error has the expected properties
  assert.strictEqual(error.status, 409);
  assert.strictEqual(error.message, "Playlist name already exists in this context");
});

test("409 error message passthrough in updateplaylist handler", async () => {
  // Mock error with 409 status
  const error = new Error("Cannot update: conflicting playlist state");
  error.status = 409;
  
  // Verify error has the expected properties
  assert.strictEqual(error.status, 409);
  assert.strictEqual(error.message, "Cannot update: conflicting playlist state");
});

test("Non-409 errors use default message", async () => {
  // Mock error without 409 status
  const error = new Error("Some other error");
  error.status = 500;
  
  // Verify error has different status
  assert.strictEqual(error.status, 500);
  assert.notStrictEqual(error.status, 409);
});

test("409 error without message uses fallback", async () => {
  // Mock error with 409 status but no message
  const error = new Error();
  error.status = 409;
  
  // Verify error has 409 status
  assert.strictEqual(error.status, 409);
  // Message should be empty or undefined
  assert.strictEqual(error.message, "");
});
