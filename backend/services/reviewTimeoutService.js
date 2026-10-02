import fs from "node:fs/promises";
import { logger } from "./logger.js";
import { dbOps } from "../db/helpers/index.js";
import { downloadTracker } from "./weeklyFlow/weeklyFlowDownloadTracker.js";
import { weeklyFlowWorker } from "./weeklyFlow/weeklyFlowWorker.js";
import { recordTrackJobFailed } from "./aurralHistoryService.js";

const MAX_RESOLUTIONS_PER_RUN = 25;

function getTimeoutSettings() {
  const matching = dbOps.getSettings()?.matching || {};
  const hours = Number(matching.reviewTimeoutHours);
  return {
    // 0 = disabled (sweep no-ops); invalid/negative falls back to 48.
    reviewTimeoutHours: Number.isFinite(hours) && hours >= 0 ? hours : 48,
    reviewAction: String(matching.reviewAction || "hold").trim().toLowerCase(),
  };
}

function deniedSourceKeyFor(job) {
  const source = String(job.downloadSource || "").trim();
  const guid = String(job.releaseGuid || "").trim();
  const user = String(job.remoteUsername || "").trim();
  const file = String(job.remoteFilename || "").trim();
  if (["usenet", "ytdlp", "deemix"].includes(source)) return guid;
  return user && file ? `${user}\0${file}` : "";
}

export async function resolveTimedOutReview(job, reason, reviewAction) {
  // Status re-check: never clobber a job that left "blocked" since the sweep snapshot.
  const current = downloadTracker.getJob(job.id);
  if (!current || current.status !== "blocked") {
    return { action: "skipped" };
  }
  if (job.stagingPath) {
    await fs.rm(job.stagingPath, { force: true, recursive: true }).catch((error) => {
      logger.debug("review-timeout", "Staging cleanup failed", {
        jobId: job.id,
        error: error?.message || String(error),
      });
    });
  }
  if (reviewAction === "auto-deny") {
    const transitioned = downloadTracker.setFailed(job.id, reason);
    if (!transitioned) {
      logger.warn("review-timeout", "setFailed refused transition; leaving job untouched", {
        jobId: job.id,
      });
      return { action: "skipped" };
    }
    recordTrackJobFailed(job, reason);
    logger.info("review-timeout", "Auto-failed stale review", { jobId: job.id, reason });
    return { action: "failed" };
  }
  const key = deniedSourceKeyFor(job);
  if (job.downloadSource && key) {
    downloadTracker.recordDeniedSource(job.id, job.downloadSource, key);
    const transitioned = downloadTracker.setPending(job.id, reason, { asRetryCycle: false });
    if (!transitioned) {
      logger.warn("review-timeout", "setPending refused transition; leaving job untouched", {
        jobId: job.id,
      });
      return { action: "skipped" };
    }
    recordTrackJobFailed(job, `${reason} — retrying next candidate`);
    logger.info("review-timeout", "Auto-denied stale review", { jobId: job.id, reason });
    return { action: "denied" };
  }
  // No derivable deny key: do NOT re-queue (loops forever re-picking the same
  // source) and do NOT fail (corrupt data). Leave the job for a human.
  logger.warn("review-timeout", "Stale review has no derivable deny source key; leaving in review", {
    jobId: job.id,
    downloadSource: job.downloadSource || null,
  });
  return { action: "skipped" };
}

export async function enforceReviewTimeouts({ now = Date.now() } = {}) {
  const { reviewTimeoutHours, reviewAction } = getTimeoutSettings();
  const metrics = {
    timestamp: new Date(now).toISOString(),
    scanned: 0,
    denied: 0,
    failed: 0,
    skipped: 0,
    deferred: 0,
    errored: 0,
    errors: [],
  };
  if (reviewTimeoutHours <= 0) {
    logger.debug("review-timeout", "Review timeout disabled (reviewTimeoutHours = 0)");
    return metrics;
  }
  const cutoff = now - reviewTimeoutHours * 3600 * 1000;
  let blocked = [];
  try {
    blocked = downloadTracker.getByStatus("blocked") || [];
  } catch (error) {
    metrics.errors.push({ error: error?.message || String(error) });
    logger.error("review-timeout", "Failed to list blocked jobs", {
      error: error?.message || String(error),
    });
    return metrics;
  }
  let resolved = 0;
  for (const job of blocked) {
    metrics.scanned += 1;
    const staleSince = Number(job.completedAt);
    if (!Number.isFinite(staleSince) || staleSince <= 0) {
      metrics.skipped += 1;
      metrics.errors.push({ jobId: job.id, error: "missing completedAt" });
      continue;
    }
    if (staleSince >= cutoff) continue;
    if (resolved >= MAX_RESOLUTIONS_PER_RUN) {
      metrics.deferred += 1;
      continue;
    }
    const reason = `Auto-resolved: review timed out after ${reviewTimeoutHours}h`;
    try {
      const result = await resolveTimedOutReview(job, reason, reviewAction);
      if (result.action === "denied") {
        metrics.denied += 1;
        resolved += 1;
      } else if (result.action === "failed") {
        metrics.failed += 1;
        resolved += 1;
      } else {
        metrics.skipped += 1;
      }
    } catch (error) {
      metrics.errored += 1;
      metrics.errors.push({ jobId: job.id, error: error?.message || String(error) });
    }
  }
  if (resolved > 0) {
    try {
      weeklyFlowWorker.wake();
    } catch (error) {
      logger.warn("review-timeout", "wake() failed after sweep", {
        error: error?.message || String(error),
      });
    }
  }
  logger.info("review-timeout", "Review timeout sweep complete", {
    scanned: metrics.scanned,
    denied: metrics.denied,
    failed: metrics.failed,
    skipped: metrics.skipped,
    deferred: metrics.deferred,
    errored: metrics.errored,
    errorCount: metrics.errors.length,
    reviewAction,
    reviewTimeoutHours,
  });
  return metrics;
}
