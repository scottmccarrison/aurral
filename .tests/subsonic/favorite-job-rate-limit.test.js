import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps, userOps },
  { hashPassword },
  { indexLidarrLibrary },
  { flowPlaylistConfig },
  { downloadTracker },
  { weeklyFlowWorker },
  { updateSharedPlaylist },
  subsonic,
  { warmImageProxy },
  { playlistManager },
] = await setupIsolatedBackend(
  "favorite-job-rate-limit",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/middleware/passwordHash.js",
  "backend/services/libraryLidarrIndexer.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/weeklyFlow/weeklyFlowWorker.js",
  "backend/services/weeklyFlow/weeklyFlowOperations.js",
  "backend/services/subsonicLibraryService.js",
  "backend/services/imageProxyService.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistManager.js",
);

const {
  getFavoriteJobStats,
  resetFavoriteJobRateLimiterForTests,
  starMany,
} = subsonic;

let user;
let flowPlaylist;

test.before(async () => {
  resetDatabase(db);
  dbOps.updateSettings({
    integrations: { general: { authUser: "alice", authPassword: "password123" } },
    security: { localNetworkBypass: { enabled: false } },
    onboardingComplete: true,
    subsonic: { favoriteAutoKeep: true },
  });

  user = userOps.createUser("alice", hashPassword("password123"), "admin");

  // Create a flow playlist
  flowPlaylist = flowPlaylistConfig.createFlow({ name: "Test Flow", size: 100 });

  // Create download jobs for the flow playlist tracks
  // This is necessary for resolvePlaylistSong to work
  // Store job IDs for use in tests
  global.flowPlaylistJobIds = [];
  for (let i = 0; i < 100; i++) {
    const jobId = downloadTracker.addJob({
      artistName: `Test Artist ${i}`,
      albumName: `Test Album ${i}`,
      trackName: `Test Track ${i}`,
      durationMs: 180000,
    }, flowPlaylist.id);
    // Mark as done so they can be resolved
    downloadTracker.setDone(jobId, `/test/track-${i}.mp3`);
    global.flowPlaylistJobIds.push(jobId);
  }
});

test.beforeEach(() => {
  resetFavoriteJobRateLimiterForTests();
});

test.afterEach(() => {
  // Clear library jobs from the database
  db.prepare("DELETE FROM playlist_download_jobs WHERE playlist_type = ?").run("library");
  
  // Clear the in-memory job index for library jobs only
  // We need to preserve flow playlist jobs created in setup
  const allJobs = downloadTracker.getAll();
  for (const job of allJobs) {
    if (job.playlistType === "library") {
      downloadTracker.removeJob(job.id);
    }
  }
  
  // Clear the stars
  db.prepare("DELETE FROM subsonic_stars WHERE user_id = ?").run(user.id);
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("single star creates job immediately without rate limiting", () => {
  const trackId = `flow-song:${encodeURIComponent(`${flowPlaylist.id}:${global.flowPlaylistJobIds[0]}`)}`;

  const result = starMany(user, [trackId]);
  assert.equal(result, true);

  const stats = getFavoriteJobStats();
  assert.equal(stats.createdInWindow, 1);
  assert.equal(stats.skippedTotal, 0);

  // Verify star was written
  const starRow = db.prepare(
    "SELECT 1 FROM subsonic_stars WHERE user_id = ? AND entity_kind = ? LIMIT 1",
  ).get(user.id, "flow-song");
  assert.ok(starRow);
});

test("burst of >50 favorited playlist songs respects rate limit", () => {
  // Create 75 track IDs from the flow playlist
  const trackIds = [];
  for (let i = 0; i < 75; i++) {
    trackIds.push(`flow-song:${encodeURIComponent(`${flowPlaylist.id}:${global.flowPlaylistJobIds[i]}`)}`);
  }

  // Star all 75 tracks
  const result = starMany(user, trackIds);
  assert.equal(result, true);

  const stats = getFavoriteJobStats();
  // Should create exactly 50 jobs (the limit)
  assert.equal(stats.createdInWindow, 50);
  // Should skip 25 jobs (75 - 50)
  assert.equal(stats.skippedTotal, 25);

  // Verify all 75 stars were written (stars persist regardless of rate limit)
  const starCount = db.prepare(
    "SELECT COUNT(*) as count FROM subsonic_stars WHERE user_id = ? AND entity_kind = ?",
  ).get(user.id, "flow-song");
  assert.equal(starCount.count, 75);

  // Verify only 50 download jobs were created
  const jobCount = db.prepare(
    "SELECT COUNT(*) as count FROM playlist_download_jobs WHERE playlist_type = ?",
  ).get("library");
  assert.equal(jobCount.count, 50);
});

test("rate limit resets after multiple calls within window", () => {
  // Star 30 tracks (within limit)
  const trackIds30 = [];
  for (let i = 0; i < 30; i++) {
    trackIds30.push(`flow-song:${encodeURIComponent(`${flowPlaylist.id}:${global.flowPlaylistJobIds[i]}`)}`);
  }
  const result1 = starMany(user, trackIds30);
  assert.equal(result1, true);

  let stats = getFavoriteJobStats();
  assert.equal(stats.createdInWindow, 30);
  assert.equal(stats.skippedTotal, 0);

  // Star 25 more tracks (still within limit: 30 + 25 = 55, but limit is 50)
  const trackIds25 = [];
  for (let i = 30; i < 55; i++) {
    trackIds25.push(`flow-song:${encodeURIComponent(`${flowPlaylist.id}:${global.flowPlaylistJobIds[i]}`)}`);
  }
  const result2 = starMany(user, trackIds25);
  assert.equal(result2, true);

  stats = getFavoriteJobStats();
  // 30 + 20 = 50 (25 requested, but only 20 fit in the remaining budget)
  assert.equal(stats.createdInWindow, 50);
  // 5 skipped (25 requested - 20 created)
  assert.equal(stats.skippedTotal, 5);

  // Verify all 55 stars were written
  const starCount = db.prepare(
    "SELECT COUNT(*) as count FROM subsonic_stars WHERE user_id = ? AND entity_kind = ?",
  ).get(user.id, "flow-song");
  assert.equal(starCount.count, 55);

  // Verify only 50 download jobs were created
  const jobCount = db.prepare(
    "SELECT COUNT(*) as count FROM playlist_download_jobs WHERE playlist_type = ?",
  ).get("library");
  assert.equal(jobCount.count, 50);
});

test("rate limit does not affect non-playlist favorites", () => {
  // Create canonical songs (not playlist songs)
  const canonicalSongIds = [];
  for (let i = 0; i < 10; i++) {
    canonicalSongIds.push(`song:test-song-${i}`);
  }

  // Star canonical songs (should not be affected by rate limit)
  const result = starMany(user, canonicalSongIds);
  // This will return false because the songs don't exist in the library,
  // but the rate limit should not have been applied
  assert.equal(result, false);

  const stats = getFavoriteJobStats();
  // Rate limit should not have been incremented for non-playlist songs
  assert.equal(stats.createdInWindow, 0);
  assert.equal(stats.skippedTotal, 0);
});

test("rate limit window slides after 60 seconds", async () => {
  // Use mock timers to advance time
  const { mock } = await import("node:test");
  mock.timers.enable({ apis: ["Date"] });

  try {
    // Star 50 tracks (fills the window)
    const trackIds50 = [];
    for (let i = 0; i < 50; i++) {
      trackIds50.push(`flow-song:${encodeURIComponent(`${flowPlaylist.id}:${global.flowPlaylistJobIds[i]}`)}`);
    }
    const result1 = starMany(user, trackIds50);
    assert.equal(result1, true);

    let stats = getFavoriteJobStats();
    assert.equal(stats.createdInWindow, 50);
    assert.equal(stats.skippedTotal, 0);

    // Try to star 10 more tracks (should be skipped)
    const trackIds10 = [];
    for (let i = 50; i < 60; i++) {
      trackIds10.push(`flow-song:${encodeURIComponent(`${flowPlaylist.id}:${global.flowPlaylistJobIds[i]}`)}`);
    }
    const result2 = starMany(user, trackIds10);
    assert.equal(result2, true);

    stats = getFavoriteJobStats();
    assert.equal(stats.createdInWindow, 50);
    assert.equal(stats.skippedTotal, 10);

    // Advance time by 60+ seconds
    mock.timers.tick(60_001);

    // Now we should be able to create more jobs
    const trackIds5 = [];
    for (let i = 60; i < 65; i++) {
      trackIds5.push(`flow-song:${encodeURIComponent(`${flowPlaylist.id}:${global.flowPlaylistJobIds[i]}`)}`);
    }
    const result3 = starMany(user, trackIds5);
    assert.equal(result3, true);

    stats = getFavoriteJobStats();
    // After window slide, old timestamps are pruned, so we should have 5 new creations
    assert.equal(stats.createdInWindow, 5);
    // skippedTotal is cumulative across windows
    assert.equal(stats.skippedTotal, 10);
  } finally {
    mock.timers.reset();
  }
});
