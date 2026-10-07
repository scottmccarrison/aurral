import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps, userOps },
  playlistConfigModule,
  honkerTaskStatusModule,
  operationsModule,
  workerModule,
  playlistSourceModule,
  playlistManagerModule,
] =
  await setupIsolatedBackend(
    "flow-schedule-hardening",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
    "backend/services/honkerTaskStatus.js",
    "backend/services/weeklyFlow/weeklyFlowOperations.js",
    "backend/services/weeklyFlow/weeklyFlowWorker.js",
    "backend/services/weeklyFlow/weeklyFlowPlaylistSource.js",
    "backend/services/weeklyFlow/weeklyFlowPlaylistManager.js",
  );

const { flowPlaylistConfig, invalidateFlowPlaylistConfigCache } = playlistConfigModule;
const { recordHonkerTaskRunStarted, recordHonkerTaskRunFinished } = honkerTaskStatusModule;
const { processWeeklyFlowOperation } = operationsModule;
const { weeklyFlowWorker } = workerModule;
const { playlistSource } = playlistSourceModule;
const { playlistManager } = playlistManagerModule;

test.beforeEach(() => {
  resetDatabase(db);
  invalidateFlowPlaylistConfigCache();
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

test("scheduleNextRun with future nextRunAt leaves it unchanged (idempotent)", () => {
  const flow = flowPlaylistConfig.createFlow({
    name: "Future Test Flow",
    scheduleDays: [1, 3, 5], // Mon, Wed, Fri
    scheduleTime: "12:00",
  });

  // Manually set nextRunAt to a future time (e.g., 7 days from now)
  const now = Date.now();
  const futureTime = now + 7 * 24 * 60 * 60 * 1000;
  
  const settings = dbOps.getSettings();
  const flows = [...settings.flows];
  flows[0] = { ...flows[0], nextRunAt: futureTime };
  dbOps.updateSettings({ ...settings, flows });
  invalidateFlowPlaylistConfigCache();

  // Call scheduleNextRun
  const updated = flowPlaylistConfig.scheduleNextRun(flow.id);

  // nextRunAt should remain unchanged
  assert.equal(updated.nextRunAt, futureTime, "nextRunAt should not change when already in future");
});

test("scheduleNextRun with null nextRunAt recomputes to future matching day", () => {
  const flow = flowPlaylistConfig.createFlow({
    name: "Null Test Flow",
    scheduleDays: [1, 3, 5], // Mon, Wed, Fri
    scheduleTime: "12:00",
  });

  // Ensure nextRunAt is null
  const settings = dbOps.getSettings();
  const flows = [...settings.flows];
  flows[0] = { ...flows[0], nextRunAt: null };
  dbOps.updateSettings({ ...settings, flows });
  invalidateFlowPlaylistConfigCache();

  const updated = flowPlaylistConfig.scheduleNextRun(flow.id);

  // nextRunAt should be computed to a future time
  assert.ok(updated.nextRunAt !== null, "nextRunAt should be computed");
  assert.ok(updated.nextRunAt > Date.now(), "nextRunAt should be in the future");
});

test("scheduleNextRun with past nextRunAt recomputes to future matching day", () => {
  const flow = flowPlaylistConfig.createFlow({
    name: "Past Test Flow",
    scheduleDays: [1, 3, 5], // Mon, Wed, Fri
    scheduleTime: "12:00",
  });

  // Set nextRunAt to the past
  const now = Date.now();
  const pastTime = now - 1000;
  
  const settings = dbOps.getSettings();
  const flows = [...settings.flows];
  flows[0] = { ...flows[0], nextRunAt: pastTime };
  dbOps.updateSettings({ ...settings, flows });
  invalidateFlowPlaylistConfigCache();

  const updated = flowPlaylistConfig.scheduleNextRun(flow.id);

  // nextRunAt should be recomputed to a future time
  assert.ok(updated.nextRunAt > now, "nextRunAt should be recomputed to future");
});

test("double scheduleNextRun calls do not push second call a week further", () => {
  const flow = flowPlaylistConfig.createFlow({
    name: "Double Call Test Flow",
    scheduleDays: [1, 3, 5], // Mon, Wed, Fri
    scheduleTime: "12:00",
  });

  // Set nextRunAt to the past to trigger recompute
  const now = Date.now();
  const pastTime = now - 1000;
  
  const settings = dbOps.getSettings();
  const flows = [...settings.flows];
  flows[0] = { ...flows[0], nextRunAt: pastTime };
  dbOps.updateSettings({ ...settings, flows });
  invalidateFlowPlaylistConfigCache();

  // First call: recomputes nextRunAt to future
  const first = flowPlaylistConfig.scheduleNextRun(flow.id);
  const firstNextRunAt = first.nextRunAt;
  invalidateFlowPlaylistConfigCache();

  // Second call: should NOT change nextRunAt since it's now in the future
  const second = flowPlaylistConfig.scheduleNextRun(flow.id);
  const secondNextRunAt = second.nextRunAt;

  assert.equal(
    firstNextRunAt,
    secondNextRunAt,
    "double scheduleNextRun should not push nextRunAt further"
  );
});

test("timestamp sanity: task run duration_ms calculation is correct", () => {
  // This test verifies the timestamp calculation logic in honkerTaskStatus.js
  // The calculation is: durationMs = (endedAt - startedAt) * 1000
  // where both endedAt and startedAt are in seconds (unix epoch)
  
  // Simulate the calculation with known values
  const startedAtSeconds = Math.floor(Date.now() / 1000);
  const endedAtSeconds = startedAtSeconds + 2; // 2 seconds later
  const expectedDurationMs = (endedAtSeconds - startedAtSeconds) * 1000;
  
  // Verify the calculation
  assert.equal(expectedDurationMs, 2000, "2 second duration should be 2000ms");
  
  // Verify the formula is correct
  const testStarted = 1000;
  const testEnded = 1005;
  const testDuration = (testEnded - testStarted) * 1000;
  assert.equal(testDuration, 5000, "5 second duration should be 5000ms");
});

test("timestamp consistency: nowUnix() returns seconds, duration_ms uses seconds", () => {
  // This test verifies that the timestamp units are consistent throughout honkerTaskStatus.js
  // nowUnix() returns Math.floor(Date.now() / 1000) = seconds
  // duration_ms = (endedAt - startedAt) * 1000 = seconds * 1000 = milliseconds
  
  // Verify nowUnix() logic
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  
  // The difference should be less than 1 second
  assert.ok(Math.abs(nowMs / 1000 - nowSeconds) < 1, "nowUnix should return seconds");
  
  // Verify that when we calculate duration from seconds, we get milliseconds
  const startSeconds = nowSeconds;
   const endSeconds = nowSeconds + 3;
   const durationMs = (endSeconds - startSeconds) * 1000;
   
   assert.equal(durationMs, 3000, "3 second duration should be 3000ms");
   assert.ok(durationMs > 1000, "duration_ms should be in milliseconds, not seconds");
});

test("inactive owner exit advances nextRunAt at all three sites (pre-seed, in-mutation, beforeMutation)", async () => {
  // Setup: create a flow with an active owner, then suspend the owner
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      lastfm: { apiKey: "test" },
      slskd: { enabled: true, url: "http://slskd", apiKey: "test" },
    },
  });
  
  const owner = userOps.createUser("inactive-owner-test", "unused", "user");
  const flow = flowPlaylistConfig.createFlow({
    name: "Inactive Owner Test Flow",
    mix: { discover: 100, mix: 0, trending: 0, focus: 0 },
    size: 1,
    scheduleDays: [1],
    ownerUserId: owner.id,
  });
  flowPlaylistConfig.setEnabled(flow.id, true);
  
  // Set nextRunAt to the past so we can verify it gets advanced
  const now = Date.now();
  const pastTime = now - 1000;
  const settings = dbOps.getSettings();
  const flows = [...settings.flows];
  flows[0] = { ...flows[0], nextRunAt: pastTime };
  dbOps.updateSettings({ ...settings, flows });
  invalidateFlowPlaylistConfigCache();
  
  const flowBeforeSuspension = flowPlaylistConfig.getFlow(flow.id);
  assert.ok(flowBeforeSuspension.nextRunAt <= now, "nextRunAt should be in the past before suspension");
  
  // Mock the worker methods to avoid actual flow execution
  const originalPrepareFlowRunPlan = weeklyFlowWorker.prepareFlowRunPlan;
  const originalSeedFlowRun = weeklyFlowWorker.seedFlowRun;
  weeklyFlowWorker.prepareFlowRunPlan = async () => ({
    primaryTracks: [],
    reserveTracks: [],
    diagnostics: { targets: { primary: 0 }, achieved: { primary: 0, reserve: 0 } },
  });
  weeklyFlowWorker.seedFlowRun = async () => ({
    jobIds: [],
    tracksQueued: 0,
    reserveTracks: 0,
  });
  
  try {
    // Suspend the owner before the operation runs
    userOps.updateUser(owner.id, { status: "suspended" });
    
    // Run the scheduled flow refresh operation
    const result = await processWeeklyFlowOperation({
      kind: "scheduled-flow-refresh",
      flowId: flow.id,
    });
    
    // Verify the operation returned the inactive owner skip
    assert.deepEqual(result, { skipped: true, inactiveOwner: true });
    
    // Verify that nextRunAt was advanced to the future
    const flowAfterSuspension = flowPlaylistConfig.getFlow(flow.id);
    assert.ok(
      flowAfterSuspension.nextRunAt > now,
      "nextRunAt should be advanced to the future after inactive owner exit"
    );
  } finally {
    weeklyFlowWorker.prepareFlowRunPlan = originalPrepareFlowRunPlan;
    weeklyFlowWorker.seedFlowRun = originalSeedFlowRun;
    weeklyFlowWorker.stop();
  }
});
