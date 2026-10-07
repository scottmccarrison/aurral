import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, honkerTaskStatus] = await setupIsolatedBackend(
  "playlist-job-indexes",
  "backend/config/db-sqlite.js",
  "backend/services/honkerTaskStatus.js",
);

test.beforeEach(async () => {
  await resetDatabase(db);
  // Trigger honker schema creation by calling a function that uses it
  honkerTaskStatus.recordHonkerTaskRunStarted(
    { id: 1, queue: "test-queue", payload: {} },
    null,
  );
});

test.after(async () => {
  db.close();
  await cleanupIsolatedState(isolatedState);
});

test("all new playlist_download_jobs indexes exist in sqlite_master", () => {
  const indexes = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'playlist_download_jobs'`,
    )
    .all()
    .map((row) => row.name);

  const requiredIndexes = [
    "idx_playlist_download_jobs_status",
    "idx_playlist_download_jobs_playlist_id",
    "idx_playlist_download_jobs_type_created",
    "idx_playlist_download_jobs_status_created",
    "idx_playlist_download_jobs_type_status",
    "idx_playlist_download_jobs_pending_created",
  ];

  for (const indexName of requiredIndexes) {
    assert.ok(
      indexes.includes(indexName),
      `Index ${indexName} not found in playlist_download_jobs`,
    );
  }
});

test("honker_task_runs index for name-lookup exists", () => {
  const indexes = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'honker_task_runs'`,
    )
    .all()
    .map((row) => row.name);

  assert.ok(
    indexes.includes("idx_honker_task_runs_name_started"),
    "Index idx_honker_task_runs_name_started not found in honker_task_runs",
  );
});

test("partial index predicate matches query filters exactly", () => {
  const indexInfo = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_playlist_download_jobs_pending_created'`,
    )
    .get();

  assert.ok(indexInfo, "Partial index not found");
  assert.ok(
    indexInfo.sql.includes("WHERE status = 'pending' AND upgrade_for_job_id IS NULL"),
    "Partial index predicate does not match expected filter",
  );
});

test("sqlite version is 3.8.0 or higher", () => {
  const versionRow = db.prepare("SELECT sqlite_version()").get();
  const version = versionRow["sqlite_version()"];
  console.log(`SQLite version: ${version}`);

  const parts = version.split(".").map((p) => parseInt(p, 10));
  const major = parts[0];
  const minor = parts[1];

  assert.ok(
    major > 3 || (major === 3 && minor >= 8),
    `SQLite version ${version} is below 3.8.0`,
  );
});

test("representative tracker queries execute successfully with indexes", () => {
  // Insert test data
  const jobId1 = "job-1";
  const jobId2 = "job-2";
  const jobId3 = "job-3";

  db.prepare(
    `INSERT INTO playlist_download_jobs (
      id, artist_name, track_name, playlist_id, playlist_type, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(jobId1, "Artist A", "Song A", "playlist-1", "discover", "pending", 1000);

  db.prepare(
    `INSERT INTO playlist_download_jobs (
      id, artist_name, track_name, playlist_id, playlist_type, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(jobId2, "Artist B", "Song B", "playlist-1", "discover", "downloading", 1001);

  db.prepare(
    `INSERT INTO playlist_download_jobs (
      id, artist_name, track_name, playlist_id, playlist_type, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(jobId3, "Artist C", "Song C", "playlist-2", "library", "pending", 1002);

  // Test livePlaylistJobsStmt shape: WHERE playlist_type = ? ORDER BY created_at, id
  const playlistTypeResults = db
    .prepare(
      `SELECT * FROM playlist_download_jobs WHERE playlist_type = ? ORDER BY created_at, id`,
    )
    .all("discover");
  assert.equal(playlistTypeResults.length, 2);
  assert.equal(playlistTypeResults[0].id, jobId1);
  assert.equal(playlistTypeResults[1].id, jobId2);

  // Test livePlaylistJobsLimitedStmt shape: WHERE playlist_type = ? ORDER BY created_at, id LIMIT ?
  const limitedResults = db
    .prepare(
      `SELECT * FROM playlist_download_jobs WHERE playlist_type = ? ORDER BY created_at, id LIMIT ?`,
    )
    .all("discover", 1);
  assert.equal(limitedResults.length, 1);
  assert.equal(limitedResults[0].id, jobId1);

  // Test liveStatusJobsStmt shape: WHERE status = ? ORDER BY created_at, id
  const statusResults = db
    .prepare(
      `SELECT * FROM playlist_download_jobs WHERE status = ? ORDER BY created_at, id`,
    )
    .all("pending");
  assert.equal(statusResults.length, 2);
  assert.equal(statusResults[0].id, jobId1);
  assert.equal(statusResults[1].id, jobId3);

  // Test liveStatsStmt shape: GROUP BY playlist_type, status
  const statsResults = db
    .prepare(
      `SELECT playlist_type, status, COUNT(*) AS count FROM playlist_download_jobs GROUP BY playlist_type, status`,
    )
    .all();
  assert.ok(statsResults.length > 0);
  const discoverPending = statsResults.find(
    (r) => r.playlist_type === "discover" && r.status === "pending",
  );
  assert.equal(discoverPending?.count, 1);

  // Test pending query shape: WHERE status = 'pending' AND upgrade_for_job_id IS NULL ORDER BY created_at, id LIMIT 1
  const pendingResults = db
    .prepare(
      `SELECT * FROM playlist_download_jobs WHERE status = 'pending' AND upgrade_for_job_id IS NULL ORDER BY created_at, id LIMIT 1`,
    )
    .all();
  assert.equal(pendingResults.length, 1);
  assert.equal(pendingResults[0].id, jobId1);

  // Test liveActivePlaylistStmt shape: WHERE playlist_type = ? AND status IN ('pending', 'downloading') LIMIT 1
  const activeResults = db
    .prepare(
      `SELECT 1 FROM playlist_download_jobs WHERE playlist_type = ? AND status IN ('pending', 'downloading') LIMIT 1`,
    )
    .all("discover");
  assert.equal(activeResults.length, 1);
});

test("EXPLAIN QUERY PLAN shows index usage for pending query", () => {
  // Insert test data
  db.prepare(
    `INSERT INTO playlist_download_jobs (
      id, artist_name, track_name, playlist_id, playlist_type, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("job-1", "Artist A", "Song A", "playlist-1", "discover", "pending", 1000);

  // Get EXPLAIN QUERY PLAN for the pending query (verbatim from liveNextPendingStmt/livePendingStmt)
  const pendingQueryText = `SELECT * FROM playlist_download_jobs WHERE status = 'pending' AND upgrade_for_job_id IS NULL ORDER BY created_at, id LIMIT 1`;
  const explainResults = db
    .prepare(`EXPLAIN QUERY PLAN ${pendingQueryText}`)
    .all();

  // Convert to string for inspection
  const explainText = explainResults.map((row) => row.detail).join("\n");
  console.log("EXPLAIN QUERY PLAN for pending query:\n", explainText);

  // Assert truthful contract: the query must use an index that serves the status filter.
  // The planner may choose either:
  // - idx_playlist_download_jobs_status_created (composite: status, created_at) — preferred for this query shape
  // - idx_playlist_download_jobs_pending_created (partial: created_at WHERE status='pending' AND upgrade_for_job_id IS NULL) — fallback
  // Both are valid; the planner prefers (status, created_at) because it covers the filter directly.
  const usesStatusIndex =
    explainText.includes("idx_playlist_download_jobs_status_created") ||
    explainText.includes("idx_playlist_download_jobs_pending_created");

  assert.ok(
    usesStatusIndex && explainText.includes("USING INDEX"),
    `Query plan must use an index serving the status filter. Expected idx_playlist_download_jobs_status_created or idx_playlist_download_jobs_pending_created with USING INDEX. Got:\n${explainText}`,
  );
});

test("EXPLAIN QUERY PLAN shows index usage for playlist_type query", () => {
  // Insert test data
  db.prepare(
    `INSERT INTO playlist_download_jobs (
      id, artist_name, track_name, playlist_id, playlist_type, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("job-1", "Artist A", "Song A", "playlist-1", "discover", "pending", 1000);

  // Get EXPLAIN QUERY PLAN for the livePlaylistJobsStmt query shape
  const playlistQueryText = `SELECT * FROM playlist_download_jobs WHERE playlist_type = ? ORDER BY created_at, id`;
  const explainResults = db
    .prepare(`EXPLAIN QUERY PLAN ${playlistQueryText}`)
    .all("discover");

  // Convert to string for inspection
  const explainText = explainResults.map((row) => row.detail).join("\n");
  console.log("EXPLAIN QUERY PLAN for playlist_type query:\n", explainText);

  // Assert: must use idx_playlist_download_jobs_type_created for (playlist_type, created_at) ordering
  assert.ok(
    explainText.includes("idx_playlist_download_jobs_type_created") &&
      explainText.includes("USING INDEX"),
    `Query plan must use idx_playlist_download_jobs_type_created. Got:\n${explainText}`,
  );
});
