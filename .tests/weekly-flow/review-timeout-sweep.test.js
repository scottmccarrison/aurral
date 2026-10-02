import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  importFromRepo,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps },
  reviewTimeoutModule,
  historyModule,
  honkerDbModule,
  systemTaskModule,
] = await setupIsolatedBackend(
  "review-timeout-sweep",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/reviewTimeoutService.js",
  "backend/services/aurralHistoryService.js",
  "backend/services/honkerDb.js",
  "backend/services/systemTaskWorker.js",
);

const { enforceReviewTimeouts, resolveTimedOutReview } = reviewTimeoutModule;
const { getAurralHistoryRequests } = historyModule;
const { downloadTracker } = await importFromRepo(
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
);

const HOUR_MS = 60 * 60 * 1000;
// Synthetic clock: 49h past the real "now" makes 48h-stale jobs due without sleeping.
const staleNow = () => Date.now() + 49 * HOUR_MS;

test.beforeEach(() => {
  resetDatabase(db);
  db.prepare("DELETE FROM aurral_history").run();
  const transaction = honkerDbModule.getHonkerDb().transaction();
  transaction.execute("DELETE FROM _honker_live WHERE queue = ?", ["weekly-flow-operation"]);
  transaction.commit();
  downloadTracker.clearAll();
  // resetDatabase() clears the settings rows behind the cache's back.
  dbOps.invalidateSettingsCache();
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

/** Seed a review-hold job exactly the way the download pipeline does. */
function seedBlockedJob({
  artistName = "Artist",
  trackName = "Song",
  albumName = "Album",
  downloadSource = "usenet",
  releaseGuid = null,
  remoteUsername = null,
  remoteFilename = null,
  stagingPath = null,
  error = "blocked-duration-mismatch",
} = {}) {
  const jobId = downloadTracker.addJob({ artistName, trackName, albumName }, "playlist-1");
  // updateDownloadMetadata ignores empty values, so omit keys we want left unset.
  const metadata = { downloadSource };
  if (releaseGuid) metadata.releaseGuid = releaseGuid;
  if (remoteUsername) metadata.remoteUsername = remoteUsername;
  if (remoteFilename) metadata.remoteFilename = remoteFilename;
  downloadTracker.updateDownloadMetadata(jobId, metadata);
  downloadTracker.setBlocked(jobId, error, stagingPath);
  return jobId;
}

/** Backdate completedAt (the review-hold timestamp) without waiting. */
function backdateJob(jobId, hours) {
  const job = downloadTracker.getJob(jobId);
  job.completedAt = Date.now() - hours * HOUR_MS;
  return job;
}

async function createStagingFile(name) {
  const dir = path.join(isolatedState.baseDir, "staging");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, "staged-audio");
  return file;
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function historyEntryFor(jobId) {
  const entries = await getAurralHistoryRequests();
  return entries.find((entry) => entry.jobId === jobId) || null;
}

test("stale review with the default hold action auto-denies to the next candidate", async () => {
  const stagingPath = await createStagingFile("hold-song.flac");
  const jobId = seedBlockedJob({
    trackName: "Hold Song",
    releaseGuid: "guid-hold",
    stagingPath,
  });

  const metrics = await enforceReviewTimeouts({ now: staleNow() });

  const job = downloadTracker.getJob(jobId);
  assert.equal(job.status, "pending");
  assert.equal(job.stagingPath, null);
  assert.deepEqual(job.deniedRemoteSources, [["usenet", "guid-hold"]]);
  assert.equal(await pathExists(stagingPath), false, "staged review file must be cleaned up");
  assert.equal(metrics.scanned, 1);
  assert.equal(metrics.denied, 1);
  assert.equal(metrics.failed, 0);
  assert.equal(metrics.skipped, 0);
  assert.deepEqual(metrics.errors, []);

  const entry = await historyEntryFor(jobId);
  assert.equal(entry?.status, "failed");
  assert.match(entry?.subtitle || "", /review timed out after 48h/);
});

test("stale review with retry-next-candidate denies the same way as hold", async () => {
  dbOps.updateSettings({ matching: { reviewAction: "retry-next-candidate" } });
  const stagingPath = await createStagingFile("retry-song.flac");
  const jobId = seedBlockedJob({
    trackName: "Retry Song",
    releaseGuid: "guid-retry",
    stagingPath,
  });

  const metrics = await enforceReviewTimeouts({ now: staleNow() });

  const job = downloadTracker.getJob(jobId);
  assert.equal(job.status, "pending");
  assert.deepEqual(job.deniedRemoteSources, [["usenet", "guid-retry"]]);
  assert.equal(await pathExists(stagingPath), false);
  assert.equal(metrics.denied, 1);
  assert.equal(metrics.failed, 0);

  const entry = await historyEntryFor(jobId);
  assert.equal(entry?.status, "failed");
  assert.match(entry?.subtitle || "", /retrying next candidate/);
});

test("stale review with auto-deny fails terminally", async () => {
  dbOps.updateSettings({ matching: { reviewAction: "auto-deny" } });
  const jobId = seedBlockedJob({ trackName: "Denied Song", releaseGuid: "guid-deny" });

  const metrics = await enforceReviewTimeouts({ now: staleNow() });

  const job = downloadTracker.getJob(jobId);
  assert.equal(job.status, "failed");
  assert.match(job.error || "", /timed out/);
  assert.equal(metrics.failed, 1);
  assert.equal(metrics.denied, 0);

  const entry = await historyEntryFor(jobId);
  assert.equal(entry?.status, "failed");
  assert.match(entry?.subtitle || "", /review timed out after 48h/);
});

test("a fresh review-hold job is left alone", async () => {
  const jobId = seedBlockedJob({ trackName: "Fresh Song", releaseGuid: "guid-fresh" });

  const metrics = await enforceReviewTimeouts({ now: Date.now() });

  assert.equal(downloadTracker.getJob(jobId).status, "blocked");
  assert.equal(metrics.scanned, 1);
  assert.equal(metrics.denied, 0);
  assert.equal(metrics.failed, 0);
  assert.equal(metrics.skipped, 0);
});

test("old jobs that are not awaiting review are never touched", async () => {
  const jobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Done Song", albumName: "Album" },
    "playlist-1",
  );
  downloadTracker.setDone(jobId, path.join(isolatedState.baseDir, "done-song.flac"), "Album");
  backdateJob(jobId, 100);

  const metrics = await enforceReviewTimeouts({ now: Date.now() });

  const job = downloadTracker.getJob(jobId);
  assert.equal(job.status, "done");
  assert.equal(job.finalPath, path.join(isolatedState.baseDir, "done-song.flac"));
  assert.equal(metrics.scanned, 0, "only blocked jobs are candidates for the sweep");
  assert.equal(metrics.denied, 0);
  assert.equal(metrics.failed, 0);
});

test("matching settings changes apply to the next sweep without a restart", async () => {
  const jobId = seedBlockedJob({ trackName: "Hot Reload Song", releaseGuid: "guid-hot" });
  const twoHoursOut = Date.now() + 2 * HOUR_MS;

  // Under the 48h default a 2h-old hold is not due yet.
  const before = await enforceReviewTimeouts({ now: twoHoursOut });
  assert.equal(downloadTracker.getJob(jobId).status, "blocked");
  assert.equal(before.denied, 0);

  dbOps.updateSettings({
    matching: {
      autoApproveDistance: 0.10,
      autoDenyDistance: 0.50,
      reviewTimeoutHours: 1,
      reviewAction: "hold",
      trackNumberMismatchTolerance: true,
      albumVersionMatching: true,
      requireExactAlbumMatch: false,
    },
  });

  // A full matching write must not silently reset sibling keys.
  const matching = dbOps.getSettings().matching;
  assert.equal(matching.reviewTimeoutHours, 1);
  assert.equal(matching.reviewAction, "hold");
  assert.equal(matching.autoApproveDistance, 0.10);
  assert.equal(matching.autoDenyDistance, 0.50);
  assert.equal(matching.trackNumberMismatchTolerance, true);
  assert.equal(matching.albumVersionMatching, true);
  assert.equal(matching.requireExactAlbumMatch, false);

  const after = await enforceReviewTimeouts({ now: twoHoursOut });
  assert.equal(after.denied, 1);
  assert.equal(downloadTracker.getJob(jobId).status, "pending");
});

test("reviewTimeoutHours: 0 disables the sweep", async () => {
  dbOps.updateSettings({ matching: { reviewTimeoutHours: 0 } });
  assert.equal(dbOps.getSettings().matching.reviewTimeoutHours, 0);
  const jobId = seedBlockedJob({ trackName: "Kept Song", releaseGuid: "guid-kept" });

  const metrics = await enforceReviewTimeouts({ now: staleNow() });

  assert.equal(downloadTracker.getJob(jobId).status, "blocked");
  assert.equal(metrics.scanned, 0);
  assert.equal(metrics.denied, 0);
  assert.equal(metrics.failed, 0);
  assert.equal(metrics.skipped, 0);
  assert.equal(metrics.deferred, 0);
  assert.deepEqual(metrics.errors, []);
  assert.equal(typeof metrics.timestamp, "string");
});

test("resolveTimedOutReview refuses to clobber a job that left review", async () => {
  const jobId = seedBlockedJob({ trackName: "Race Song", releaseGuid: "guid-race" });
  const snapshot = { ...downloadTracker.getJob(jobId) };
  downloadTracker.setDone(jobId, path.join(isolatedState.baseDir, "race.flac"), "Album");

  const result = await resolveTimedOutReview(
    snapshot,
    "Auto-resolved: review timed out after 48h",
    "hold",
  );

  assert.deepEqual(result, { action: "skipped" });
  const job = downloadTracker.getJob(jobId);
  assert.equal(job.status, "done");
  assert.deepEqual(job.deniedRemoteSources ?? [], []);
  assert.equal(await historyEntryFor(jobId), null);
});

test("a stale review with no derivable deny key stays held for a human", async () => {
  // slskd deny keys need remoteUsername + remoteFilename; both are absent here.
  const jobId = seedBlockedJob({ trackName: "Keyless Song", downloadSource: "slskd" });

  const metrics = await enforceReviewTimeouts({ now: staleNow() });

  const job = downloadTracker.getJob(jobId);
  assert.equal(job.status, "blocked", "re-queueing without a deny key would loop forever");
  assert.deepEqual(job.deniedRemoteSources ?? [], []);
  assert.equal(metrics.scanned, 1);
  assert.equal(metrics.skipped, 1);
  assert.equal(metrics.denied, 0);
  assert.equal(metrics.failed, 0);
});

test("a single sweep resolves at most 25 reviews and defers the rest", async () => {
  const jobIds = [];
  for (let index = 0; index < 30; index += 1) {
    jobIds.push(
      seedBlockedJob({
        trackName: `Bulk Song ${index}`,
        releaseGuid: `guid-bulk-${index}`,
      }),
    );
  }

  const metrics = await enforceReviewTimeouts({ now: staleNow() });

  assert.equal(metrics.scanned, 30);
  assert.equal(metrics.denied, 25);
  assert.equal(metrics.deferred, 5);
  assert.equal(metrics.failed, 0);
  assert.equal(downloadTracker.getByStatus("blocked").length, 5);
  assert.equal(downloadTracker.getByStatus("pending").length, 25);
  assert.equal(jobIds.filter((id) => downloadTracker.getJob(id).status === "pending").length, 25);
});

test("the sweep is registered as a flow-owned scheduled task and dispatches", async () => {
  const task = honkerDbModule.SCHEDULED_SYSTEM_TASKS.find(
    (entry) => entry.name === "review-timeout-sweep",
  );
  assert.ok(task, "review-timeout-sweep must be a scheduled system task");
  assert.equal(task.queue, "system-task");
  assert.equal(task.schedule, "@every 30m");
  assert.equal(task.payload.kind, "review-timeout-sweep");
  assert.equal(honkerDbModule.getSystemTaskQueueName(task.payload.kind), "system-task");

  const jobId = seedBlockedJob({ trackName: "Dispatch Song", releaseGuid: "guid-dispatch" });
  backdateJob(jobId, 49);

  const result = await systemTaskModule.processSystemTask({ kind: "review-timeout-sweep" });

  assert.equal(typeof result.timestamp, "string");
  for (const key of ["scanned", "denied", "failed", "skipped", "deferred"]) {
    assert.equal(typeof result[key], "number", `${key} must be reported`);
  }
  assert.ok(Array.isArray(result.errors));
  assert.equal(result.scanned, 1);
  assert.equal(result.denied, 1);
  assert.equal(downloadTracker.getJob(jobId).status, "pending");
});
