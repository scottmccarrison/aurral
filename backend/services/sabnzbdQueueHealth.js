import { sabnzbdClient } from "./sabnzbdClient.js";
import { dbOps } from "../db/helpers/index.js";
import { logger } from "./logger.js";

function normalizeTitle(filename) {
  return String(filename || "")
    .toLowerCase()
    .replace(/\.nzb$/i, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 8)
    .join(" ");
}

function getHealthSettings() {
  const sabnzbd = dbOps.getSettings()?.integrations?.sabnzbd || {};
  return {
    healthCheckIntervalMinutes: sabnzbd.healthCheckIntervalMinutes ?? 5,
    autoResumeAfterSpaceFreed: sabnzbd.autoResumeAfterSpaceFreed ?? true,
    deduplicateQueue: sabnzbd.deduplicateQueue ?? true,
    cleanupCompletedAfterMinutes: sabnzbd.cleanupCompletedAfterMinutes ?? 30,
  };
}

export async function maintainSabnzbdQueueHealth() {
  const settings = getHealthSettings();
  const metrics = {
    timestamp: new Date().toISOString(),
    queueBefore: 0,
    queueAfter: 0,
    duplicatesRemoved: 0,
    stalledResumed: 0,
    completedCleaned: 0,
    errors: [],
  };

  try {
    if (!sabnzbdClient.isConfigured()) {
      logger.debug("sabnzbd-health", "SABnzbd not configured, skipping health check");
      return metrics;
    }

    const queue = await sabnzbdClient.getQueue();
    const slots = queue?.slots || [];
    metrics.queueBefore = slots.length;

    if (slots.length === 0) {
      logger.debug("sabnzbd-health", "Queue empty, nothing to do");
      metrics.queueAfter = 0;
      return metrics;
    }

    // 1. Deduplicate — remove duplicate NZBs (same title)
    if (settings.deduplicateQueue) {
      const seen = new Map();
      for (const slot of slots) {
        const key = normalizeTitle(slot.filename || slot.name);
        if (seen.has(key)) {
          try {
            await sabnzbdClient.deleteQueueItem(slot.nzo_id);
            metrics.duplicatesRemoved++;
            logger.debug("sabnzbd-health", "Removed duplicate NZB", {
              nzoId: slot.nzo_id,
              filename: slot.filename,
            });
          } catch (error) {
            metrics.errors.push({ action: "delete-duplicate", nzoId: slot.nzo_id, error: error?.message });
          }
        } else {
          seen.set(key, slot.nzo_id);
        }
      }
    }

    // 2. Unstale — resume items paused > 1 hour (if disk OK)
    if (settings.autoResumeAfterSpaceFreed) {
      try {
        const disk = await sabnzbdClient.getDiskSpace();
        const diskSpaceOK = disk.freeBytes > 1024 * 1024 * 1024; // > 1GB free

        if (diskSpaceOK) {
          for (const slot of slots) {
            const isPaused = slot.status === "Paused" || slot.status === "Queued";
            const pausedLongEnough = slot.avg_age && parseFloat(slot.avg_age) > 3600;

            if (isPaused && pausedLongEnough) {
              try {
                await sabnzbdClient.resumeQueueItem(slot.nzo_id);
                metrics.stalledResumed++;
                logger.debug("sabnzbd-health", "Resumed stalled item", {
                  nzoId: slot.nzo_id,
                  filename: slot.filename,
                  age: slot.avg_age,
                });
              } catch (error) {
                metrics.errors.push({ action: "resume-stalled", nzoId: slot.nzo_id, error: error?.message });
              }
            }
          }
        }
      } catch (error) {
        metrics.errors.push({ action: "check-disk-space", error: error?.message });
      }
    }

    // 3. Cleanup — remove completed items older than threshold from history
    if (settings.cleanupCompletedAfterMinutes > 0) {
      try {
        const history = await sabnzbdClient.getHistory(100);
        const historySlots = history?.slots || [];
        const cutoff = Date.now() - settings.cleanupCompletedAfterMinutes * 60 * 1000;

        for (const item of historySlots) {
          const completedAt = item.completed * 1000;
          if (completedAt && completedAt < cutoff) {
            try {
              await sabnzbdClient.deleteHistoryItem(item.nzo_id);
              metrics.completedCleaned++;
              logger.debug("sabnzbd-health", "Cleaned old history item", {
                nzoId: item.nzo_id,
                filename: item.filename,
                completed: item.completed,
              });
            } catch (error) {
              metrics.errors.push({ action: "delete-history", nzoId: item.nzo_id, error: error?.message });
            }
          }
        }
      } catch (error) {
        metrics.errors.push({ action: "cleanup-history", error: error?.message });
      }
    }

    // 4. Report — log health metrics
    const finalQueue = await sabnzbdClient.getQueue();
    metrics.queueAfter = finalQueue?.slots?.length || 0;

    logger.info("sabnzbd-health", "Queue health check complete", {
      queueBefore: metrics.queueBefore,
      queueAfter: metrics.queueAfter,
      duplicatesRemoved: metrics.duplicatesRemoved,
      stalledResumed: metrics.stalledResumed,
      completedCleaned: metrics.completedCleaned,
      errorCount: metrics.errors.length,
    });

    return metrics;
  } catch (error) {
    logger.error("sabnzbd-health", "Queue health check failed", {
      error: error?.message || String(error),
    });
    metrics.errors.push({ action: "health-check", error: error?.message });
    return metrics;
  }
}
