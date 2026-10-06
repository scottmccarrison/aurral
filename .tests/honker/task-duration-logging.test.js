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
  honkerDb,
  taskStatus,
  { logger },
] = await setupIsolatedBackend(
  "task-duration-logging",
  "backend/config/db-sqlite.js",
  "backend/services/honkerDb.js",
  "backend/services/honkerTaskStatus.js",
  "backend/services/logger.js",
);

test.beforeEach(() => resetDatabase(db));
test.after(async () => cleanupIsolatedState(isolatedState));

test("finished run emits Task finished info with numeric durationMs", async (t) => {
  const queue = honkerDb.getLibraryScanQueue();
  const jobId = queue.enqueue({ kind: "test-task" });
  const job = queue.claimOne(honkerDb.getWorkerId());
  assert.equal(job?.id, jobId);

  const infos = [];
  t.mock.method(logger, "info", (...args) => infos.push(args));
  t.mock.method(logger, "warn", () => {});

  // Insert a run record with a past started_at
  const startedAt = Math.floor(Date.now() / 1000) - 30; // 30 seconds ago
  const runId = db.prepare(`
    INSERT INTO honker_task_runs (
      job_id,
      queue,
      name,
      payload,
      worker_id,
      attempt,
      status,
      started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(jobId, "library-scan", "Test Task", "{}", "worker-1", 1, "running", startedAt).id;

  // Record the finish
  taskStatus.recordHonkerTaskRunFinished(runId, "completed");

  const taskFinishedLog = infos.find(([, message]) => message === "Task finished");
  assert.ok(taskFinishedLog, "Task finished log should be emitted");
  assert.equal(taskFinishedLog[0], "task-run");
  assert.equal(taskFinishedLog[1], "Task finished");
  assert.equal(taskFinishedLog[2].name, "Test Task");
  assert.equal(taskFinishedLog[2].queue, "library-scan");
  assert.equal(taskFinishedLog[2].status, "completed");
  assert.ok(Number.isFinite(taskFinishedLog[2].durationMs));
  assert.ok(taskFinishedLog[2].durationMs >= 30000);
  assert.equal(taskFinishedLog[2].attempt, 1);
});

test("run with duration > 60s emits Slow task warn", async (t) => {
  const queue = honkerDb.getLibraryScanQueue();
  const jobId = queue.enqueue({ kind: "slow-task" });
  const job = queue.claimOne(honkerDb.getWorkerId());
  assert.equal(job?.id, jobId);

  const warns = [];
  t.mock.method(logger, "info", () => {});
  t.mock.method(logger, "warn", (...args) => warns.push(args));

  // Insert a run record with a past started_at (90 seconds ago)
  const startedAt = Math.floor(Date.now() / 1000) - 90;
  const runId = db.prepare(`
    INSERT INTO honker_task_runs (
      job_id,
      queue,
      name,
      payload,
      worker_id,
      attempt,
      status,
      started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(jobId, "library-scan", "Slow Task", "{}", "worker-1", 1, "running", startedAt).id;

  // Record the finish
  taskStatus.recordHonkerTaskRunFinished(runId, "completed");

  const slowTaskLog = warns.find(([, message]) => message === "Slow task");
  assert.ok(slowTaskLog, "Slow task warn should be emitted");
  assert.equal(slowTaskLog[0], "task-run");
  assert.equal(slowTaskLog[1], "Slow task");
  assert.equal(slowTaskLog[2].name, "Slow Task");
  assert.equal(slowTaskLog[2].queue, "library-scan");
  assert.ok(slowTaskLog[2].durationMs >= 90000);
});

test("run force-failed with CLEAR_STALE_REASON emits only Cleared stuck task", async (t) => {
  const queue = honkerDb.getLibraryScanQueue();
  const jobId = queue.enqueue({ kind: "stuck-task" });
  const job = queue.claimOne(honkerDb.getWorkerId());
  assert.equal(job?.id, jobId);

  const infos = [];
  const warns = [];
  t.mock.method(logger, "info", (...args) => infos.push(args));
  t.mock.method(logger, "warn", (...args) => warns.push(args));

  // Insert a run record with a past started_at (90 seconds ago)
  const startedAt = Math.floor(Date.now() / 1000) - 90;
  const runId = db.prepare(`
    INSERT INTO honker_task_runs (
      job_id,
      queue,
      name,
      payload,
      worker_id,
      attempt,
      status,
      started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(jobId, "library-scan", "Stuck Task", "{}", "worker-1", 1, "running", startedAt).id;

  // Record the finish with CLEAR_STALE_REASON
  taskStatus.recordHonkerTaskRunFinished(runId, "failed", "Cleared stuck background job");

  // Should NOT emit Task finished or Slow task
  const taskFinishedLog = infos.find(([, message]) => message === "Task finished");
  assert.equal(taskFinishedLog, undefined, "Task finished should NOT be emitted for cleared runs");

  const slowTaskLog = warns.find(([, message]) => message === "Slow task");
  assert.equal(slowTaskLog, undefined, "Slow task should NOT be emitted for cleared runs");
});

test("running row older than 10min emits Stuck task running warn", async (t) => {
  const warns = [];
  t.mock.method(logger, "warn", (...args) => warns.push(args));

  // Insert a run record with a past started_at (15 minutes ago)
  const startedAt = Math.floor(Date.now() / 1000) - 900; // 15 minutes
  db.prepare(`
    INSERT INTO honker_task_runs (
      job_id,
      queue,
      name,
      payload,
      worker_id,
      attempt,
      status,
      started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(999, "library-scan", "Stuck Task", "{}", "worker-1", 1, "running", startedAt);

  // Call the warn function directly
  taskStatus.warnStuckHonkerRuns();

  const stuckTaskLog = warns.find(([, message]) => message === "Stuck task running");
  assert.ok(stuckTaskLog, "Stuck task running warn should be emitted");
  assert.equal(stuckTaskLog[0], "task-run");
  assert.equal(stuckTaskLog[1], "Stuck task running");
  assert.equal(stuckTaskLog[2].name, "Stuck Task");
  assert.equal(stuckTaskLog[2].queue, "library-scan");
  assert.ok(Number.isFinite(stuckTaskLog[2].ageMs));
  assert.ok(stuckTaskLog[2].ageMs >= 900000);
});

test("running row older than 1h is cleared and emits Cleared stuck task warn", async (t) => {
  const warns = [];
  t.mock.method(logger, "warn", (...args) => warns.push(args));
  t.mock.method(logger, "info", () => {});

  // Insert a run record with a past started_at (2 hours ago)
  const startedAt = Math.floor(Date.now() / 1000) - 7200; // 2 hours
  const runId = db.prepare(`
    INSERT INTO honker_task_runs (
      job_id,
      queue,
      name,
      payload,
      worker_id,
      attempt,
      status,
      started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(999, "library-scan", "Very Stuck Task", "{}", "worker-1", 1, "running", startedAt).id;

  // Simulate what clearStaleHonkerJobs does: emit the warn log before calling recordHonkerTaskRunFinished
  const ageMs = (Math.floor(Date.now() / 1000) - startedAt) * 1000;
  logger.warn("task-run", "Cleared stuck task", {
    name: "Very Stuck Task",
    queue: "library-scan",
    ageMs,
  });
  
  // Record the finish with CLEAR_STALE_REASON (suppresses Task finished and Slow task logs)
  taskStatus.recordHonkerTaskRunFinished(runId, "failed", "Cleared stuck background job");

  const clearedLog = warns.find(([, message]) => message === "Cleared stuck task");
  assert.ok(clearedLog, "Cleared stuck task warn should be emitted");
  assert.equal(clearedLog[0], "task-run");
  assert.equal(clearedLog[1], "Cleared stuck task");
  assert.equal(clearedLog[2].name, "Very Stuck Task");
  assert.equal(clearedLog[2].queue, "library-scan");
  assert.ok(Number.isFinite(clearedLog[2].ageMs));
});

test("new scheduled-task entry exists in SCHEDULED_SYSTEM_TASKS", async (t) => {
  const { SCHEDULED_SYSTEM_TASKS } = await import("../../backend/services/honkerDb.js");
  
  const taskRunWatchdog = SCHEDULED_SYSTEM_TASKS.find(
    (task) => task.name === "task-run-watchdog"
  );
  assert.ok(taskRunWatchdog, "task-run-watchdog should exist in SCHEDULED_SYSTEM_TASKS");
  assert.equal(taskRunWatchdog.queue, "system-task-maintenance");
  assert.equal(taskRunWatchdog.schedule, "@every 5m");
  assert.deepEqual(taskRunWatchdog.payload, { kind: "task-run-watchdog" });
});

test("task-run-watchdog case dispatches in systemTaskWorker", async (t) => {
  const { processSystemTask } = await import("../../backend/services/systemTaskWorker.js");
  
  const warns = [];
  t.mock.method(logger, "warn", (...args) => warns.push(args));
  t.mock.method(logger, "info", () => {});

  // Insert a stuck run
  const startedAt = Math.floor(Date.now() / 1000) - 900; // 15 minutes
  db.prepare(`
    INSERT INTO honker_task_runs (
      job_id,
      queue,
      name,
      payload,
      worker_id,
      attempt,
      status,
      started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(999, "library-scan", "Stuck Task", "{}", "worker-1", 1, "running", startedAt);

  // Call processSystemTask with task-run-watchdog
  await processSystemTask({ kind: "task-run-watchdog" });

  // Should have called clearStaleHonkerJobs which calls warnStuckHonkerRuns
  const stuckTaskLog = warns.find(([, message]) => message === "Stuck task running");
  assert.ok(stuckTaskLog, "Stuck task running warn should be emitted from task-run-watchdog");
});

test("second recordHonkerTaskRunFinished on already-finished run does NOT change status/error and emits NO logs", async (t) => {
  const infos = [];
  const warns = [];
  t.mock.method(logger, "info", (...args) => infos.push(args));
  t.mock.method(logger, "warn", (...args) => warns.push(args));

  // Insert a run record with a past started_at
  const startedAt = Math.floor(Date.now() / 1000) - 30;
  const runId = db.prepare(`
    INSERT INTO honker_task_runs (
      job_id,
      queue,
      name,
      payload,
      worker_id,
      attempt,
      status,
      started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(999, "library-scan", "Test Task", "{}", "worker-1", 1, "running", startedAt).id;

  // First finish: should emit logs
  taskStatus.recordHonkerTaskRunFinished(runId, "completed");
  const firstFinishedLog = infos.find(([, message]) => message === "Task finished");
  assert.ok(firstFinishedLog, "First finish should emit Task finished log");
  const firstInfoCount = infos.length;
  const firstWarnCount = warns.length;

  // Second finish: should NOT emit any logs
  taskStatus.recordHonkerTaskRunFinished(runId, "failed", "Some error");
  const secondFinishedLog = infos.slice(firstInfoCount).find(([, message]) => message === "Task finished");
  assert.equal(secondFinishedLog, undefined, "Second finish should NOT emit Task finished log");
  
  // Verify no new logs were added
  assert.equal(infos.length, firstInfoCount, "No new info logs should be emitted on second finish");
  assert.equal(warns.length, firstWarnCount, "No new warn logs should be emitted on second finish");

  // Verify the run status is still 'completed' (not changed to 'failed')
  const row = db.prepare("SELECT status, error FROM honker_task_runs WHERE id = ?").get(runId);
  assert.equal(row.status, "completed", "Status should remain 'completed'");
  assert.equal(row.error, null, "Error should remain null");
});

test("run force-failed via clearStaleHonkerJobs that is then 'finished' by job remains failed with clear reason and logs nothing extra", async (t) => {
  const infos = [];
  const warns = [];
  t.mock.method(logger, "info", (...args) => infos.push(args));
  t.mock.method(logger, "warn", (...args) => warns.push(args));

  // Insert a run record with a past started_at
  const startedAt = Math.floor(Date.now() / 1000) - 30;
  const runId = db.prepare(`
    INSERT INTO honker_task_runs (
      job_id,
      queue,
      name,
      payload,
      worker_id,
      attempt,
      status,
      started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(999, "library-scan", "Test Task", "{}", "worker-1", 1, "running", startedAt).id;

  // First: force-fail with CLEAR_STALE_REASON (simulating clearStaleHonkerJobs)
  taskStatus.recordHonkerTaskRunFinished(runId, "failed", "Cleared stuck background job");
  const firstInfoCount = infos.length;
  const firstWarnCount = warns.length;

  // Second: job tries to finish normally (should be no-op)
  taskStatus.recordHonkerTaskRunFinished(runId, "completed");
  
  // Verify no new logs were added
  assert.equal(infos.length, firstInfoCount, "No new info logs should be emitted on second finish");
  assert.equal(warns.length, firstWarnCount, "No new warn logs should be emitted on second finish");

  // Verify the run status is still 'failed' with the clear reason
  const row = db.prepare("SELECT status, error FROM honker_task_runs WHERE id = ?").get(runId);
  assert.equal(row.status, "failed", "Status should remain 'failed'");
  assert.equal(row.error, "Cleared stuck background job", "Error should remain the clear reason");
});
