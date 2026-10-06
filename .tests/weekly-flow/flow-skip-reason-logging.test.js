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
  schedulerModule,
  { logger },
] = await setupIsolatedBackend(
  "flow-skip-reason-logging",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
  "backend/services/weeklyFlow/weeklyFlowScheduler.js",
  "backend/services/logger.js",
);

const { flowPlaylistConfig, invalidateFlowPlaylistConfigCache } = playlistConfigModule;
const { runScheduledRefresh } = schedulerModule;

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

test("getScheduledRefreshSkipReasons classifies disabled flows correctly", () => {
  const disabledFlow = flowPlaylistConfig.createFlow({
    name: "Disabled Flow 1",
  });

  const skipReasons = flowPlaylistConfig.getScheduledRefreshSkipReasons();
  const disabledEntry = skipReasons.find((entry) => entry.flowId === disabledFlow.id);

  assert.ok(disabledEntry);
  assert.equal(disabledEntry.reason, "disabled");
});

test("getScheduledRefreshSkipReasons classifies missing-next-run flows correctly", () => {
  const flow = flowPlaylistConfig.createFlow({
    name: "Missing Next Run Flow",
  });
  // Enable the flow but leave nextRunAt as null
  const settings = dbOps.getSettings();
  const flowToUpdate = settings.flows.find((f) => f.id === flow.id);
  if (flowToUpdate) {
    flowToUpdate.enabled = true;
    flowToUpdate.nextRunAt = null;
    dbOps.updateSettings(settings);
    invalidateFlowPlaylistConfigCache();
  }

  const skipReasons = flowPlaylistConfig.getScheduledRefreshSkipReasons();
  const missingEntry = skipReasons.find((entry) => entry.flowId === flow.id);

  assert.ok(missingEntry);
  assert.equal(missingEntry.reason, "missing-next-run");
});

test("getScheduledRefreshSkipReasons classifies not-due flows correctly", () => {
  const futureTime = Date.now() + 24 * 60 * 60 * 1000; // 24 hours from now
  const flow = flowPlaylistConfig.createFlow({
    name: "Not Due Flow 1",
  });
  // Enable the flow and set nextRunAt to future time
  const settings = dbOps.getSettings();
  const flowToUpdate = settings.flows.find((f) => f.id === flow.id);
  if (flowToUpdate) {
    flowToUpdate.enabled = true;
    flowToUpdate.nextRunAt = futureTime;
    dbOps.updateSettings(settings);
    invalidateFlowPlaylistConfigCache();
  }

  const skipReasons = flowPlaylistConfig.getScheduledRefreshSkipReasons();
  const notDueEntry = skipReasons.find((entry) => entry.flowId === flow.id);

  assert.ok(notDueEntry);
  assert.equal(notDueEntry.reason, "not-due");
  assert.equal(notDueEntry.nextRunAt, futureTime);
});

test("getDueForRefresh behavior is unchanged", () => {
  const now = Date.now();
  const pastTime = now - 60 * 60 * 1000; // 1 hour ago
  const futureTime = now + 24 * 60 * 60 * 1000; // 24 hours from now

  const dueFlow = flowPlaylistConfig.createFlow({
    name: "Due Flow 1",
  });
  const notDueFlow = flowPlaylistConfig.createFlow({
    name: "Not Due Flow 2",
  });
  const disabledFlow = flowPlaylistConfig.createFlow({
    name: "Disabled Flow 2",
  });

  // Set nextRunAt times and enable flows
  const settings = dbOps.getSettings();
  const dueFlowToUpdate = settings.flows.find((f) => f.id === dueFlow.id);
  const notDueFlowToUpdate = settings.flows.find((f) => f.id === notDueFlow.id);
  const disabledFlowToUpdate = settings.flows.find((f) => f.id === disabledFlow.id);

  if (dueFlowToUpdate) {
    dueFlowToUpdate.enabled = true;
    dueFlowToUpdate.nextRunAt = pastTime;
  }
  if (notDueFlowToUpdate) {
    notDueFlowToUpdate.enabled = true;
    notDueFlowToUpdate.nextRunAt = futureTime;
  }
  if (disabledFlowToUpdate) {
    disabledFlowToUpdate.enabled = false;
    disabledFlowToUpdate.nextRunAt = pastTime;
  }

  dbOps.updateSettings(settings);
  invalidateFlowPlaylistConfigCache();

  const due = flowPlaylistConfig.getDueForRefresh();
  assert.equal(due.length, 1);
  assert.equal(due[0].id, dueFlow.id);
});

test("not-due entries log at debug level not info", async (t) => {
  const futureTime = Date.now() + 24 * 60 * 60 * 1000;

  const flow = flowPlaylistConfig.createFlow({
    name: "Not Due Flow 3",
  });

  const settings = dbOps.getSettings();
  const flowToUpdate = settings.flows.find((f) => f.id === flow.id);
  if (flowToUpdate) {
    flowToUpdate.enabled = true;
    flowToUpdate.nextRunAt = futureTime;
  }
  dbOps.updateSettings(settings);
  invalidateFlowPlaylistConfigCache();

  const debugLogs = [];
  const infoLogs = [];
  t.mock.method(logger, "debug", (...args) => debugLogs.push(args));
  t.mock.method(logger, "info", (...args) => infoLogs.push(args));

  await runScheduledRefresh();

  const notDueDebugLog = debugLogs.find(
    ([category, message]) =>
      category === "flow-schedule" && message === "Scheduled refresh skipped: not-due",
  );
  assert.ok(notDueDebugLog);

  const notDueInfoLog = infoLogs.find(
    ([category, message]) =>
      category === "flow-schedule" && message === "Scheduled refresh skipped: not-due",
  );
  assert.equal(notDueInfoLog, undefined);
});

test("scheduler logs inactive owner skip reason", async (t) => {
  // Create a user with inactive status
  const inactiveUser = userOps.createUser("inactive-user", "hash", "user");
  const inactiveUserId = inactiveUser.id;
  
  // Set user status to inactive
  userOps.updateUser(inactiveUserId, { status: "inactive" });

  const now = Date.now();
  const pastTime = now - 60 * 60 * 1000;

  const flow = flowPlaylistConfig.createFlow({
    name: "Inactive Owner Flow",
    ownerUserId: inactiveUserId,
  });

  // Set nextRunAt to past (due) and enable
  const updatedSettings = dbOps.getSettings();
  const flowToUpdate = updatedSettings.flows.find((f) => f.id === flow.id);
  if (flowToUpdate) {
    flowToUpdate.enabled = true;
    flowToUpdate.nextRunAt = pastTime;
  }
  dbOps.updateSettings(updatedSettings);
  invalidateFlowPlaylistConfigCache();

  const logs = [];
  t.mock.method(logger, "info", (...args) => logs.push(args));

  await runScheduledRefresh();

  const inactiveOwnerLog = logs.find(
    ([category, message]) =>
      category === "flow-schedule" && message === "Scheduled refresh skipped: inactive owner",
  );
  assert.ok(inactiveOwnerLog);
  assert.equal(inactiveOwnerLog[2].flowId, flow.id);
  assert.equal(inactiveOwnerLog[2].ownerUserId, inactiveUserId);
});


