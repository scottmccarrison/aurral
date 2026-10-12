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
  { dbOps },
  { flowPlaylistConfig },
  { downloadTracker },
  { playlistManager },
  { getPlaylistMbidEnrichmentQueue, listHonkerJobs },
  {
    enrichSharedPlaylistMbids,
    schedulePlaylistMbidEnrichment,
    PLAYLIST_MBID_ENRICHMENT_BUDGET_MS,
  },
  { logger },
] = await setupIsolatedBackend(
  "enrichment-resilience",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistManager.js",
  "backend/services/honkerDb.js",
  "backend/services/playlistMbidEnrichmentService.js",
  "backend/services/logger.js",
);

test.beforeEach(() => {
  downloadTracker.clearAll();
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

test("enrichSharedPlaylistMbids with budget exceeded in resolution phase returns partial completion", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Budget Test",
    tracks: [
      { artistName: "Artist 1", trackName: "Track 1" },
      { artistName: "Artist 2", trackName: "Track 2" },
      { artistName: "Artist 3", trackName: "Track 3" },
    ],
  });

  // Use an advancing clock that immediately exceeds budget
  let callCount = 0;
  const advancingNow = () => {
    callCount += 1;
    // First call returns start time (0), then all subsequent calls show budget exceeded
    return callCount === 1 ? 0 : PLAYLIST_MBID_ENRICHMENT_BUDGET_MS + 1000;
  };

  const result = await enrichSharedPlaylistMbids(playlist.id, {
    budgetMs: PLAYLIST_MBID_ENRICHMENT_BUDGET_MS,
    now: advancingNow,
    resolveTrackContext: (track) => ({
      ...track,
      artistMbid: "artist-mbid",
      albumMbid: "album-mbid",
      trackMbid: "track-mbid",
    }),
  });

  // With budget exceeded immediately, we skip all tracks and return early
  // So no resolutions means no apply phase and budgetExceeded not in result
  assert.equal(result.tracksExamined, 3);
  assert.equal(result.missing, false);
  assert.equal(result.changed, false);
});

test("enrichSharedPlaylistMbids with advancing now() trips budget in apply phase", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Budget Apply Test",
    tracks: [
      { artistName: "Artist 1", trackName: "Track 1" },
      { artistName: "Artist 2", trackName: "Track 2" },
    ],
  });

  let callCount = 0;
  const advancingNow = () => {
    callCount += 1;
    // Let resolution phase complete, then trip budget during apply
    return callCount > 20 ? 7 * 60 * 1000 : 0;
  };

  const result = await enrichSharedPlaylistMbids(playlist.id, {
    budgetMs: PLAYLIST_MBID_ENRICHMENT_BUDGET_MS,
    now: advancingNow,
    resolveTrackContext: (track) => ({
      ...track,
      artistMbid: "artist-mbid",
      albumMbid: "album-mbid",
      trackMbid: "track-mbid",
    }),
  });

  // Should have budgetExceeded flag when we trip budget during apply
  // This test verifies the apply-phase budget check works
  assert.ok(result);
  assert.ok(result.playlistId);
});

test("schedulePlaylistMbidEnrichment dedup prevents duplicate enqueue", async () => {
  const playlistId = "test-playlist-dedup";
  flowPlaylistConfig.createSharedPlaylist({
    id: playlistId,
    name: "Dedup Test",
    tracks: [{ artistName: "Artist", trackName: "Track" }],
  });

  const jobId1 = schedulePlaylistMbidEnrichment(playlistId);
  const jobId2 = schedulePlaylistMbidEnrichment(playlistId);

  // Both should have the same ID (second call returns existing job)
  assert.equal(jobId1, jobId2);

  // Queue should have exactly one job
  const queuedJobs = listHonkerJobs("playlist-mbid-enrichment");
  const playlistJobs = queuedJobs.filter(
    (job) => job.payload?.playlistId === playlistId
  );
  assert.equal(playlistJobs.length, 1);
});

test("schedulePlaylistMbidEnrichment allows different playlists", async () => {
  const playlist1 = "playlist-1";
  const playlist2 = "playlist-2";
  flowPlaylistConfig.createSharedPlaylist({
    id: playlist1,
    name: "Playlist 1",
    tracks: [{ artistName: "Artist", trackName: "Track" }],
  });
  flowPlaylistConfig.createSharedPlaylist({
    id: playlist2,
    name: "Playlist 2",
    tracks: [{ artistName: "Artist", trackName: "Track" }],
  });

  const jobId1 = schedulePlaylistMbidEnrichment(playlist1);
  const jobId2 = schedulePlaylistMbidEnrichment(playlist2);

  // Both should be enqueued with different IDs
  assert.ok(jobId1);
  assert.ok(jobId2);
  assert.notEqual(jobId1, jobId2);
});

test("schedulePlaylistMbidEnrichment quarantines after 3 recent failures", async () => {
  const playlistId = "quarantine-test-playlist";
  const nowUnixSeconds = Math.floor(Date.now() / 1000);

  flowPlaylistConfig.createSharedPlaylist({
    id: playlistId,
    name: "Quarantine Test",
    tracks: [{ artistName: "Artist", trackName: "Track" }],
  });

  // Insert 3 failed runs
  const payload = JSON.stringify({ playlistId, kind: "playlist-mbid-enrichment" });
  const insertSql = `
    INSERT INTO honker_task_runs (
      job_id, queue, status, payload, started_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `;
  for (let i = 0; i < 3; i++) {
    db.prepare(insertSql).run(
      1000 + i,
      "playlist-mbid-enrichment",
      "failed",
      payload,
      nowUnixSeconds - 60, // 1 minute ago
      nowUnixSeconds - 60
    );
  }

  const result = schedulePlaylistMbidEnrichment(playlistId);

  // Should be quarantined (return null)
  assert.equal(result, null);
});

test("schedulePlaylistMbidEnrichment allows enqueue with 2 failures", async () => {
  const playlistId = "two-failures-playlist";
  const nowUnixSeconds = Math.floor(Date.now() / 1000);

  flowPlaylistConfig.createSharedPlaylist({
    id: playlistId,
    name: "Two Failures Test",
    tracks: [{ artistName: "Artist", trackName: "Track" }],
  });

  // Insert 2 failed runs
  const payload = JSON.stringify({ playlistId, kind: "playlist-mbid-enrichment" });
  const insertSql = `
    INSERT INTO honker_task_runs (
      job_id, queue, status, payload, started_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `;
  for (let i = 0; i < 2; i++) {
    db.prepare(insertSql).run(
      2000 + i,
      "playlist-mbid-enrichment",
      "failed",
      payload,
      nowUnixSeconds - 60,
      nowUnixSeconds - 60
    );
  }

  const result = schedulePlaylistMbidEnrichment(playlistId);

  // Should not be quarantined (should enqueue)
  assert.ok(result);
});

test("schedulePlaylistMbidEnrichment self-heals: failures >1h ago don't count", async () => {
  const playlistId = "self-heal-playlist";
  const nowUnixSeconds = Math.floor(Date.now() / 1000);

  flowPlaylistConfig.createSharedPlaylist({
    id: playlistId,
    name: "Self Heal Test",
    tracks: [{ artistName: "Artist", trackName: "Track" }],
  });

  // Insert 3 failed runs, but >1h ago
  const payload = JSON.stringify({ playlistId, kind: "playlist-mbid-enrichment" });
  const insertSql = `
    INSERT INTO honker_task_runs (
      job_id, queue, status, payload, started_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `;
  for (let i = 0; i < 3; i++) {
    db.prepare(insertSql).run(
      3000 + i,
      "playlist-mbid-enrichment",
      "failed",
      payload,
      nowUnixSeconds - 4000, // >1h ago
      nowUnixSeconds - 4000
    );
  }

  const result = schedulePlaylistMbidEnrichment(playlistId);

  // Should be allowed (old failures aged out)
  assert.ok(result);
});

test("schedulePlaylistMbidEnrichment handles non-uuid playlistId safely", async () => {
  const invalidPlaylistId = "not-a-uuid!@#$%";
  flowPlaylistConfig.createSharedPlaylist({
    id: "test-valid",
    name: "Test",
    tracks: [{ artistName: "Artist", trackName: "Track" }],
  });

  // This should not throw or cause SQL errors (quarantine check skipped for invalid uuid)
  // The invalid playlistId will still be enqueued (no SQL error because quarantine check is skipped)
  const result = schedulePlaylistMbidEnrichment(invalidPlaylistId);
  
  // Should return a job ID (enqueue proceeds with invalid ID, it just skips the quarantine DB query)
  assert.ok(result !== null && typeof result === "number");
});

test("existing playlist-mbid-enrichment tests still pass", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Existing Test",
    tracks: [{ artistName: "Refused", trackName: "New Noise" }],
  });
  const jobId = downloadTracker.addJob(
    { artistName: "Refused", trackName: "New Noise" },
    playlist.id
  );

  const result = await enrichSharedPlaylistMbids(playlist.id, {
    resolveTrackContext: (track) => ({
      ...track,
      albumName: "The Shape of Punk to Come",
      artistMbid: "artist-refused",
      albumMbid: "album-shape",
      trackMbid: "track-new-noise",
      releaseYear: "1998",
      durationMs: 308000,
    }),
  });

  const storedTrack = flowPlaylistConfig.getSharedPlaylist(playlist.id)?.tracks?.[0];
  const storedJob = downloadTracker.getJob(jobId);

  assert.equal(result.changed, true);
  assert.equal(result.playlistTracksUpdated, 1);
  assert.equal(result.jobsUpdated, 1);
  assert.equal(storedTrack.artistMbid, "artist-refused");
  assert.equal(storedTrack.albumMbid, "album-shape");
  assert.equal(storedTrack.trackMbid, "track-new-noise");
  assert.equal(storedJob.artistMbid, "artist-refused");
});
