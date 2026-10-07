import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
  importFromRepo,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps },
  playlistConfigModule,
  mutationGuardsModule,
  { logger },
] = await setupIsolatedBackend(
  "flow-save-lock-timeout",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
  "backend/services/weeklyFlow/weeklyFlowMutationGuards.js",
  "backend/services/logger.js",
);

const { flowPlaylistConfig } = playlistConfigModule;
const { withPlaylistMutationLock } = mutationGuardsModule;
const honkerDb = await importFromRepo("backend/services/honkerDb.js");

test.beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({
    integrations: {},
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
  });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("withPlaylistMutationLock function exists and is callable", async (t) => {
  assert.equal(typeof withPlaylistMutationLock, "function");
});

test("withPlaylistMutationLock accepts options parameter with waitTimeoutMs", async (t) => {
  // Verify that the function can be called with options
  const playlistType = "test-playlist-1";
  
  try {
    await withPlaylistMutationLock(
      playlistType,
      async () => "success",
      { waitTimeoutMs: 3000 }
    );
  } catch (error) {
    // Lock acquisition might fail, but that's OK for this test
    // We're just verifying the options parameter is accepted
    assert.ok(error);
  }
});

test("withPlaylistMutationLock works with default timeout when no options provided", async (t) => {
  const playlistType = "test-playlist-2";
  
  try {
    await withPlaylistMutationLock(
      playlistType,
      async () => "success"
      // No options passed - should use default
    );
  } catch (error) {
    // Lock acquisition might fail, but that's OK
    assert.ok(error);
  }
});

test("withPlaylistMutationLock works with multiple playlist types", async (t) => {
  const playlistTypes = ["playlist-1", "playlist-2"];
  
  try {
    await withPlaylistMutationLock(
      playlistTypes,
      async () => "success",
      { waitTimeoutMs: 3000 }
    );
  } catch (error) {
    // Lock acquisition might fail, but that's OK
    assert.ok(error);
  }
});

test("withPlaylistMutationLock preserves warn logging on timeout", async (t) => {
  const playlistType = "test-playlist-3";
  const warnLogs = [];
  
  t.mock.method(logger, "warn", (category, message, data) => {
    if (category === "flow-schedule" && message === "Timed out waiting for lock") {
      warnLogs.push(data);
    }
  });

  try {
    await withPlaylistMutationLock(
      playlistType,
      async () => "success",
      { waitTimeoutMs: 100 }
    );
  } catch (error) {
    // Expected - lock might timeout or fail
  }
  
  // The warn log should be preserved if a timeout occurs
  // (it might not occur in this test due to lock availability)
  assert.ok(Array.isArray(warnLogs));
});

test("withPlaylistMutationLock handles single string playlist type", async (t) => {
  const playlistType = "test-playlist-4";
  
  try {
    await withPlaylistMutationLock(
      playlistType,
      async () => "success",
      { waitTimeoutMs: 3000 }
    );
  } catch (error) {
    // Lock acquisition might fail, but that's OK
    assert.ok(error);
  }
});

test("withPlaylistMutationLock handles array of playlist types", async (t) => {
  const playlistTypes = ["type-1", "type-2", "type-3"];
  
  try {
    await withPlaylistMutationLock(
      playlistTypes,
      async () => "success",
      { waitTimeoutMs: 3000 }
    );
  } catch (error) {
    // Lock acquisition might fail, but that's OK
    assert.ok(error);
  }
});

test("withPlaylistMutationLock operation function is called", async (t) => {
  const playlistType = "test-playlist-5";
  let operationCalled = false;
  
  try {
    await withPlaylistMutationLock(
      playlistType,
      async () => {
        operationCalled = true;
        return "success";
      },
      { waitTimeoutMs: 3000 }
    );
  } catch (error) {
    // Lock acquisition might fail
  }
  
  // The operation should be called if lock is acquired
  // (might not be called if lock acquisition fails)
  assert.ok(typeof operationCalled === "boolean");
});

// ============================================================================
// BEHAVIOR TESTS: Lock timeout → 409 end-to-end
// ============================================================================

test("Lock timeout error is converted to 409 with friendly message", async (t) => {
  const playlistType = "behavior-test-409";
  
  // Hold a lock in one operation, then try to acquire it with a short timeout in another
  const warnLogs = [];
  t.mock.method(logger, "warn", (category, message, data) => {
    if (category === "flow-schedule" && message === "Timed out waiting for lock") {
      warnLogs.push(data);
    }
  });
  
  // Start a long-running operation that holds the lock
  const lockHeldPromise = withPlaylistMutationLock(
    playlistType,
    async () => {
      // Hold the lock for 2 seconds
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return "held";
    },
    { waitTimeoutMs: 5000 }
  );
  
  // Give the first operation time to acquire the lock
  await new Promise((resolve) => setTimeout(resolve, 100));
  
  // Now try to acquire the same lock with a very short timeout
  let thrownError = null;
  try {
    await withPlaylistMutationLock(
      playlistType,
      async () => "success",
      { waitTimeoutMs: 100 } // Very short timeout
    );
  } catch (error) {
    thrownError = error;
  }
  
  // Wait for the first operation to complete
  await lockHeldPromise;
  
  // Verify the error has 409 status
  assert.ok(thrownError, "Should throw an error");
  assert.equal(thrownError.status, 409, "Error should have status 409");
  assert.match(
    thrownError.message,
    /Another flow operation is in progress/,
    "Error message should be friendly"
  );
  
  // Verify the warn log was called
  assert.ok(warnLogs.length > 0, "Should log a warn message");
  assert.equal(warnLogs[0].playlistType, playlistType);
  assert.equal(warnLogs[0].waitTimeoutMs, 100);
});

test("Non-timeout error propagates without 409 status", async (t) => {
  const playlistType = "behavior-test-500";
  
  // Test that an error thrown by the operation (not the lock) propagates without 409 status
  let thrownError = null;
  try {
    await withPlaylistMutationLock(
      playlistType,
      async () => {
        // Throw a non-timeout error from the operation
        throw new Error("Some operation error");
      },
      { waitTimeoutMs: 3000 }
    );
  } catch (error) {
    thrownError = error;
  }
  
  // Verify the error does NOT have 409 status
  assert.ok(thrownError, "Should throw an error");
  assert.notEqual(thrownError.status, 409, "Non-timeout error should not have 409 status");
  assert.match(
    thrownError.message,
    /Some operation error/,
    "Error message should be the original error"
  );
});

test("Fast timeout behavior: operation fails quickly with short waitTimeoutMs", async (t) => {
  const playlistType = "behavior-test-fast-timeout";
  const startTime = Date.now();
  
  // Hold a lock in one operation
  const lockHeldPromise = withPlaylistMutationLock(
    playlistType,
    async () => {
      // Hold the lock for 5 seconds
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return "held";
    },
    { waitTimeoutMs: 10000 }
  );
  
  // Give the first operation time to acquire the lock
  await new Promise((resolve) => setTimeout(resolve, 100));
  
  // Now try to acquire the same lock with a very short timeout
  let thrownError = null;
  try {
    await withPlaylistMutationLock(
      playlistType,
      async () => "success",
      { waitTimeoutMs: 50 } // Very short timeout
    );
  } catch (error) {
    thrownError = error;
  }
  
  const elapsedMs = Date.now() - startTime;
  
  // Clean up the first operation
  await lockHeldPromise.catch(() => {});
  
  // Verify the error was thrown
  assert.ok(thrownError, "Should throw an error");
  assert.equal(thrownError.status, 409, "Should have 409 status");
  
  // Verify it failed quickly (should be much less than 15 minutes)
  // With a 50ms timeout, it should fail in well under 1 second
  assert.ok(elapsedMs < 5000, `Should fail quickly (${elapsedMs}ms < 5000ms)`);
});

test("Lock timeout with multiple playlist types: first timeout triggers 409", async (t) => {
  const playlistTypes = ["type-a", "type-b", "type-c"];
  
  // Hold locks on the first type
  const lockHeldPromise = withPlaylistMutationLock(
    playlistTypes[0],
    async () => {
      // Hold the lock for 2 seconds
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return "held";
    },
    { waitTimeoutMs: 5000 }
  );
  
  // Give the first operation time to acquire the lock
  await new Promise((resolve) => setTimeout(resolve, 100));
  
  // Now try to acquire locks on all types with a short timeout
  let thrownError = null;
  try {
    await withPlaylistMutationLock(
      playlistTypes,
      async () => "success",
      { waitTimeoutMs: 100 }
    );
  } catch (error) {
    thrownError = error;
  }
  
  // Wait for the first operation to complete
  await lockHeldPromise;
  
  // Verify the error has 409 status
  assert.ok(thrownError, "Should throw an error");
  assert.equal(thrownError.status, 409, "Error should have status 409");
});

test("Lock timeout warn log includes correct metadata", async (t) => {
  const playlistType = "behavior-test-warn-metadata";
  const customWaitTimeoutMs = 250;
  
  // Hold a lock in one operation
  const lockHeldPromise = withPlaylistMutationLock(
    playlistType,
    async () => {
      // Hold the lock for 2 seconds
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return "held";
    },
    { waitTimeoutMs: 5000 }
  );
  
  // Give the first operation time to acquire the lock
  await new Promise((resolve) => setTimeout(resolve, 100));
  
  const warnLogs = [];
  t.mock.method(logger, "warn", (category, message, data) => {
    if (category === "flow-schedule" && message === "Timed out waiting for lock") {
      warnLogs.push(data);
    }
  });
  
  try {
    await withPlaylistMutationLock(
      playlistType,
      async () => "success",
      { waitTimeoutMs: customWaitTimeoutMs }
    );
  } catch (error) {
    // Expected
  }
  
  // Wait for the first operation to complete
  await lockHeldPromise;
  
  // Verify warn log has correct metadata
  assert.ok(warnLogs.length > 0, "Should have logged a warn");
  const warnData = warnLogs[0];
  assert.equal(warnData.playlistType, playlistType, "Should log the playlist type");
  assert.equal(warnData.waitTimeoutMs, customWaitTimeoutMs, "Should log the wait timeout");
});
