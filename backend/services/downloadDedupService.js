/*
 * Cross-source download deduplication layer (issue #3).
 *
 * Two in-memory registries, both living in the process that runs the
 * slskd-pipeline queue (the isolated "flow" worker):
 *
 *   activeReleases: Map<releaseKey, { jobId, source, startedAt }>
 *     One claim per release identity. A claim blocks the SAME release from
 *     starting on a DIFFERENT source for a DIFFERENT job. Same-job re-entry
 *     and same-source claims (e.g. every track job of one album) are allowed.
 *
 *   failureMemory: Map<"${releaseKey}|${source}", { attempts, lastError,
 *     firstFailureAt, lastFailureAt }>
 *     Repeated failures for one release on one source suppress that
 *     source for the release until the memory window expires.
 *
 * Release identity keys are derived from a job or pipeline payload via
 * getReleaseKeys(): releaseGuid -> albumMbid -> trackMbid -> normalized
 * "artist|album" name. Jobs gain releaseGuid/releaseTitle mid-lifecycle, so
 * job-level hooks must use getReleaseKeys() (ALL identities) to find claims
 * that were keyed off the payload before the guid was known.
 *
 * The web process reaches these maps through the flow-owner RPC
 * ("getDedupStats" command); getStats() must stay JSON-serializable.
 */
import { dbOps } from "../db/helpers/index.js";
import { logger } from "./logger.js";

const DEFAULT_CONFIG = {
  deduplication: true,
  failureMemoryHours: 24,
  maxRetriesPerSource: 3,
};

const STATS_ENTRY_LIMIT = 200;
const HOUR_MS = 60 * 60 * 1000;
const FAILURE_KEY_SEPARATOR = "|";

/** releaseKey -> { jobId, source, startedAt } */
const activeReleases = new Map();
/** `${releaseKey}|${source}` -> { attempts, lastError, firstFailureAt, lastFailureAt } */
const failureMemory = new Map();

function getConfig() {
  const raw = dbOps.getSettings()?.sources ?? {};
  const parsedHours = Number(raw.failureMemoryHours);
  const parsedRetries = Number(raw.maxRetriesPerSource);
  return {
    deduplication: raw.deduplication !== false,
    failureMemoryHours:
      Number.isFinite(parsedHours) && parsedHours > 0
        ? parsedHours
        : DEFAULT_CONFIG.failureMemoryHours,
    maxRetriesPerSource:
      Number.isFinite(parsedRetries) && parsedRetries >= 1
        ? Math.floor(parsedRetries)
        : DEFAULT_CONFIG.maxRetriesPerSource,
  };
}

// Lowercase, strip punctuation, collapse whitespace so cosmetic differences
// between sources ("AC/DC" vs "AC DC") produce the same identity.
function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Every release identity derivable from a job or pipeline payload, ordered
 * by precedence: releaseGuid -> albumMbid -> trackMbid -> "artist|album"
 * (falling back to a normalized releaseTitle when names are incomplete).
 * Nested track.* fields are read when top-level fields are absent.
 */
export function getReleaseKeys(jobOrPayload) {
  const record = jobOrPayload && typeof jobOrPayload === "object" ? jobOrPayload : {};
  const track = record.track && typeof record.track === "object" ? record.track : {};
  const keys = [];
  const pushKey = (value) => {
    const key = String(value || "").trim();
    if (key && !keys.includes(key)) keys.push(key);
  };
  pushKey(record.releaseGuid);
  pushKey(record.albumMbid || track.albumMbid);
  pushKey(record.trackMbid || track.trackMbid);
  const artist = normalizeName(record.artistName || track.artistName);
  const album = normalizeName(record.albumName || track.albumName);
  if (artist && album) {
    pushKey(`${artist}${FAILURE_KEY_SEPARATOR}${album}`);
  } else {
    pushKey(normalizeName(record.releaseTitle || track.releaseTitle));
  }
  return keys;
}

/**
 * The single strongest release identity for a job or payload, or null when
 * no identity can be derived.
 */
export function getReleaseKey(jobOrPayload) {
  return getReleaseKeys(jobOrPayload)[0] || null;
}

function buildFailureKey(releaseKey, source) {
  return `${releaseKey}${FAILURE_KEY_SEPARATOR}${source}`;
}

function activeBlockReason(entry) {
  return `Release is already downloading via ${entry.source} (job ${entry.jobId})`;
}

/**
 * Whether `source` may be attempted for one release key.
 * Blocks when another job is actively downloading the release on a
 * different source, or when this source exhausted its retry budget for the
 * release within the failure-memory window.
 */
export function shouldAttempt(releaseKey, source, { jobId } = {}) {
  const config = getConfig();
  if (!config.deduplication) return { allowed: true, reason: null };
  const key = String(releaseKey || "").trim();
  const safeSource = String(source || "").trim();
  if (!key || !safeSource) return { allowed: true, reason: null };
  const safeJobId = String(jobId || "").trim();
  const active = activeReleases.get(key);
  if (active && active.jobId !== safeJobId && active.source !== safeSource) {
    logger.debug("dedup", "Skipping source: release is active on another source", {
      releaseKey: key,
      source: safeSource,
      jobId: safeJobId,
      activeJobId: active.jobId,
      activeSource: active.source,
    });
    return { allowed: false, reason: activeBlockReason(active) };
  }
  const failure = failureMemory.get(buildFailureKey(key, safeSource));
  if (failure && failure.attempts >= config.maxRetriesPerSource) {
    const ageMs = Date.now() - (failure.lastFailureAt || 0);
    if (ageMs <= config.failureMemoryHours * HOUR_MS) {
      logger.info("dedup", "Skipping source: repeated recent failures for release", {
        releaseKey: key,
        source: safeSource,
        attempts: failure.attempts,
        maxRetriesPerSource: config.maxRetriesPerSource,
        lastError: failure.lastError,
      });
      return {
        allowed: false,
        reason:
          `${safeSource} failed ${failure.attempts} times for this release ` +
          `within the last ${config.failureMemoryHours}h`,
      };
    }
  }
  return { allowed: true, reason: null };
}

/**
 * shouldAttempt across every identity of one release. Returns the first
 * blocking verdict; two payloads for the same release with different
 * available identities (e.g. one already knows the releaseGuid) still match.
 */
export function shouldAttemptAny(releaseKeys, source, options = {}) {
  const keys = Array.isArray(releaseKeys) ? releaseKeys : [];
  for (const key of keys) {
    const verdict = shouldAttempt(key, source, options);
    if (!verdict.allowed) return verdict;
  }
  return { allowed: true, reason: null };
}

/**
 * Atomic check-and-claim of EVERY identity of one release for one source and
 * job (pass getReleaseKeys(payload), mirroring shouldAttemptAny). Refuses
 * without claiming anything when another job holds ANY identity on a
 * different source; refreshes the claims when the same job or the same
 * source re-enters. Claiming all identities keeps two payloads for the same
 * release with different known identities (e.g. one already knows the
 * releaseGuid) from slipping past each other's check.
 */
export function markActive(releaseKeys, source, jobId) {
  const config = getConfig();
  if (!config.deduplication) return { claimed: true, reason: null };
  pruneExpired();
  const keys = (Array.isArray(releaseKeys) ? releaseKeys : [releaseKeys])
    .map((key) => String(key || "").trim())
    .filter(Boolean);
  const safeSource = String(source || "").trim();
  const safeJobId = String(jobId || "").trim();
  if (keys.length === 0 || !safeSource) return { claimed: true, reason: null };
  // Check every identity before claiming any: a partial claim would leave
  // the unchecked identities open to a competing job.
  for (const key of keys) {
    const existing = activeReleases.get(key);
    if (existing && existing.jobId !== safeJobId && existing.source !== safeSource) {
      logger.debug("dedup", "Refusing claim: release is active on another source", {
        releaseKey: key,
        source: safeSource,
        jobId: safeJobId,
        activeJobId: existing.jobId,
        activeSource: existing.source,
      });
      return { claimed: false, reason: activeBlockReason(existing) };
    }
  }
  // One shared entry per claim; markComplete/clearJob release every key.
  const entry = {
    jobId: safeJobId,
    source: safeSource,
    startedAt: Date.now(),
  };
  for (const key of keys) {
    activeReleases.set(key, entry);
  }
  return { claimed: true, reason: null };
}

/**
 * Release finished successfully: drop the active claim and forget every
 * recorded failure for this release identity. Job-level callers should loop
 * getReleaseKeys(job) so claims keyed off other identities are cleared too.
 */
export function markComplete(releaseKey) {
  const key = String(releaseKey || "").trim();
  if (!key) return;
  activeReleases.delete(key);
  const prefix = `${key}${FAILURE_KEY_SEPARATOR}`;
  for (const failureKey of failureMemory.keys()) {
    if (failureKey.startsWith(prefix)) {
      failureMemory.delete(failureKey);
    }
  }
}

/**
 * One source attempt failed: drop this source's active claim for the
 * release and count the failure. The active entry is only removed when it
 * belongs to the failing source, so a claim-refusal path can never release
 * another job's claim held on a different source.
 */
export function markFailed(releaseKey, source, error) {
  const config = getConfig();
  if (!config.deduplication) return;
  pruneExpired();
  const key = String(releaseKey || "").trim();
  const safeSource = String(source || "").trim();
  if (!key || !safeSource) return;
  const active = activeReleases.get(key);
  if (active && active.source === safeSource) {
    activeReleases.delete(key);
  }
  const failureKey = buildFailureKey(key, safeSource);
  const now = Date.now();
  const lastError = String(error?.message || error || "").trim() || null;
  const existing = failureMemory.get(failureKey);
  if (existing) {
    existing.attempts += 1;
    existing.lastError = lastError;
    existing.lastFailureAt = now;
  } else {
    failureMemory.set(failureKey, {
      attempts: 1,
      lastError,
      firstFailureAt: now,
      lastFailureAt: now,
    });
  }
}

/**
 * Record one source failure against EVERY identity of the release, exactly
 * once per key (getReleaseKeys deduplicates).
 */
export function recordSourceFailure(payloadOrJob, source, error) {
  const safeSource = String(source || "").trim();
  if (!safeSource) return;
  for (const key of getReleaseKeys(payloadOrJob)) {
    markFailed(key, safeSource, error);
  }
}

/**
 * Drop any active claim held by this job. jobId-based clearing is precise:
 * it never releases another job's same-source re-claim.
 */
export function clearJob(jobId) {
  const safeJobId = String(jobId || "").trim();
  if (!safeJobId) return;
  for (const [key, entry] of activeReleases) {
    if (entry.jobId === safeJobId) {
      activeReleases.delete(key);
    }
  }
}

/** Drop failure-memory entries whose window has elapsed. */
export function pruneExpired() {
  const config = getConfig();
  const cutoff = Date.now() - config.failureMemoryHours * HOUR_MS;
  for (const [failureKey, entry] of failureMemory) {
    if ((entry.lastFailureAt || 0) <= cutoff) {
      failureMemory.delete(failureKey);
    }
  }
}

/** Serializable snapshot for the dashboard API (via flow-owner RPC). */
export function getStats() {
  const active = [];
  for (const [releaseKey, entry] of activeReleases) {
    if (active.length >= STATS_ENTRY_LIMIT) break;
    active.push({
      releaseKey,
      jobId: entry.jobId,
      source: entry.source,
      startedAt: entry.startedAt,
    });
  }
  const failures = [];
  for (const [failureKey, entry] of failureMemory) {
    if (failures.length >= STATS_ENTRY_LIMIT) break;
    // releaseKey may itself contain "|"; the source is the final segment.
    const separator = failureKey.lastIndexOf(FAILURE_KEY_SEPARATOR);
    failures.push({
      key: failureKey,
      releaseKey: separator === -1 ? failureKey : failureKey.slice(0, separator),
      source: separator === -1 ? null : failureKey.slice(separator + 1),
      attempts: entry.attempts,
      lastError: entry.lastError,
      firstFailureAt: entry.firstFailureAt,
      lastFailureAt: entry.lastFailureAt,
    });
  }
  return {
    activeReleases: active,
    failureMemory: failures,
    config: getConfig(),
  };
}

/** Clear all dedup state (tests / manual reset). */
export function resetAll() {
  activeReleases.clear();
  failureMemory.clear();
}
