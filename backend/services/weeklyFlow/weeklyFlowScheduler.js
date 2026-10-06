import { downloadTracker } from "./weeklyFlowDownloadTracker.js";
import { weeklyFlowWorker } from "./weeklyFlowWorker.js";
import { flowPlaylistConfig } from "./weeklyFlowPlaylistConfig.js";
import { isAnyDownloadSourceConfigured } from "../downloadSourceService.js";
import { weeklyFlowOperationQueue } from "./weeklyFlowOperationQueue.js";
import { userOps } from "../../db/helpers/index.js";
import { logger } from "../logger.js";
import {
  createWeeklyFlowOperationToken,
  markLatestWeeklyFlowOperationToken,
} from "./weeklyFlowOperations.js";

function isFlowOwnerActive(flow) {
  const ownerUserId = Number(flow?.ownerUserId);
  if (!Number.isFinite(ownerUserId)) return true;
  const owner = userOps.getUserById(ownerUserId);
  return !owner || owner.status === "active";
}

export async function runScheduledRefresh() {
  if (!isAnyDownloadSourceConfigured()) {
    logger.info("flow-schedule", "Scheduled refresh skipped: no download source configured");
    return;
  }

  const due = flowPlaylistConfig.getDueForRefresh();
  if (due.length === 0) {
    logger.info("flow-schedule", "Scheduled refresh skipped: no flows due");
    // Log skip reasons for non-due flows
    const skipReasons = flowPlaylistConfig.getScheduledRefreshSkipReasons();
    for (const entry of skipReasons) {
      if (entry.reason === "disabled" || entry.reason === "missing-next-run") {
        logger.info("flow-schedule", `Scheduled refresh skipped: ${entry.reason}`, {
          flowId: entry.flowId,
          reason: entry.reason,
          nextRunAt: entry.nextRunAt,
        });
      } else if (entry.reason === "not-due") {
        logger.debug("flow-schedule", `Scheduled refresh skipped: ${entry.reason}`, {
          flowId: entry.flowId,
          reason: entry.reason,
          nextRunAt: entry.nextRunAt,
        });
      }
    }
    return;
  }

  // Log skip reasons for non-due flows (once per tick, before processing due flows)
  const skipReasons = flowPlaylistConfig.getScheduledRefreshSkipReasons();
  for (const entry of skipReasons) {
    if (entry.reason === "disabled" || entry.reason === "missing-next-run") {
      logger.info("flow-schedule", `Scheduled refresh skipped: ${entry.reason}`, {
        flowId: entry.flowId,
        reason: entry.reason,
        nextRunAt: entry.nextRunAt,
      });
    } else if (entry.reason === "not-due") {
      logger.debug("flow-schedule", `Scheduled refresh skipped: ${entry.reason}`, {
        flowId: entry.flowId,
        reason: entry.reason,
        nextRunAt: entry.nextRunAt,
      });
    }
  }

  for (const flow of due) {
    if (!isFlowOwnerActive(flow)) {
      logger.info("flow-schedule", "Scheduled refresh skipped: inactive owner", {
        flowId: flow.id,
        ownerUserId: flow.ownerUserId,
      });
      continue;
    }
    try {
      const token = createWeeklyFlowOperationToken();
      const tokenScope = `flow:${flow.id}:scheduled`;
      markLatestWeeklyFlowOperationToken(tokenScope, token);
      await weeklyFlowOperationQueue.enqueuePayload({
        kind: "scheduled-flow-refresh",
        label: `scheduled:${flow.id}`,
        flowId: flow.id,
        tokenScope,
        token,
      });
    } catch (error) {
      logger.error("flow-schedule", "Scheduled refresh failed", {
        flowId: flow.id,
        error: error.message,
      });
    }
  }
}

export async function startWorkerIfPending() {
  const pending = downloadTracker.getNextPending();
  if (!pending) return;
  if (weeklyFlowWorker.running) {
    weeklyFlowWorker.wake();
    return;
  }
  await weeklyFlowWorker.start();
}
