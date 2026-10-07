import { downloadTracker } from "./weeklyFlowDownloadTracker.js";
import { weeklyFlowWorker } from "./weeklyFlowWorker.js";
import { withHonkerLock } from "../honkerDb.js";
import { isFlowOwnerProcess, requestFlowOwner } from "./weeklyFlowOwnerClient.js";
import { logger } from "../logger.js";

const normalizePlaylistTypes = (playlistTypes) => [
  ...new Set(
    (Array.isArray(playlistTypes) ? playlistTypes : [playlistTypes])
      .map((playlistType) => String(playlistType || "").trim())
      .filter(Boolean),
  ),
];

async function withPlaylistLocks(playlistTypes, operation, options = {}) {
  const sortedTypes = [...playlistTypes].sort();
  const waitTimeoutMs = options.waitTimeoutMs ?? 15 * 60 * 1000;
  const runAtIndex = async (index) => {
    if (index >= sortedTypes.length) {
      return operation();
    }
    const playlistType = sortedTypes[index];
    try {
      return await withHonkerLock(`playlist-mutation:${playlistType}`, () => runAtIndex(index + 1), {
        ttlSeconds: 180,
        waitTimeoutMs,
        retryDelayMs: 250,
      });
    } catch (error) {
      if (String(error?.message || "").includes("Timed out waiting for Honker lock")) {
        logger.warn("flow-schedule", "Timed out waiting for lock", {
          playlistType,
          waitTimeoutMs,
        });
        // Saves during seed/cleanup/run-start will 409 quickly BY DESIGN.
        // The lock is held across slow operations like beginPlaylistMutation's RPC +
        // waitForPlaylistIdle and runFlowSeed's weeklyReset/seeding.
        const err = new Error("Another flow operation is in progress (a run may be starting or finishing) — try again in a few seconds.");
        err.status = 409;
        err.cause = error;
        throw err;
      }
      throw error;
    }
  };
  return runAtIndex(0);
}

export async function beginPlaylistMutation(playlistTypes, { clearPending = true } = {}) {
  const types = normalizePlaylistTypes(playlistTypes);
  const blocked = [];
  try {
    for (const playlistType of types) {
      await weeklyFlowWorker.blockPlaylist(playlistType);
      blocked.push(playlistType);
      await weeklyFlowWorker.clearIncompleteRetry(playlistType);
      if (clearPending) {
        if (isFlowOwnerProcess()) downloadTracker.clearPendingByPlaylistType(playlistType);
        else await requestFlowOwner("clearPendingByPlaylist", [playlistType]);
      }
    }
    await Promise.all(
      types.map((playlistType) => weeklyFlowWorker.waitForPlaylistIdle(playlistType)),
    );
  } catch (error) {
    for (const playlistType of blocked) {
      try {
        await weeklyFlowWorker.unblockPlaylist(playlistType);
      } catch (unblockError) {
        logger.warn("playlists", "Could not unblock playlist after mutation setup failed", {
          playlistId: playlistType,
          reason: unblockError?.message || String(unblockError),
        });
      }
    }
    throw error;
  }
  return async () => {
    let firstError = null;
    for (const playlistType of types) {
      try {
        await weeklyFlowWorker.unblockPlaylist(playlistType);
      } catch (error) {
        firstError ??= error;
      }
    }
    try {
      await weeklyFlowWorker.pruneOrphanedJobState();
    } catch (error) {
      firstError ??= error;
    }
    if (firstError) throw firstError;
  };
}

export async function withPlaylistMutation(playlistTypes, operation, options = {}) {
  const types = normalizePlaylistTypes(playlistTypes);
  return withPlaylistMutationLock(types, async () => {
    if (typeof options.beforeMutation === "function") {
      const preflight = await options.beforeMutation();
      if (preflight !== undefined) return preflight;
    }
    const releaseMutation = await beginPlaylistMutation(types, options);
    try {
      return await operation();
    } finally {
      await releaseMutation();
    }
  }, options);
}

export async function withPlaylistMutationLock(playlistTypes, operation, options = {}) {
  const types = normalizePlaylistTypes(playlistTypes);
  return withPlaylistLocks(types, operation, options);
}

export async function restartWorkerIfPending() {
  const stillPending = downloadTracker.getNextPending();
  if (stillPending && !weeklyFlowWorker.running) {
    await weeklyFlowWorker.start();
  }
}

export async function wakeDownloadWorker() {
  if (!weeklyFlowWorker.running) {
    await weeklyFlowWorker.start();
  } else {
    weeklyFlowWorker.wake();
  }
}
