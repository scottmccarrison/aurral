import {
  fetchCoverArtArchiveFront,
  fetchCoverImageBytes,
  sniffImageMimeType,
} from "./apiClients/coverArtArchive.js";
import createCache from "./apiClients/simpleCache.js";
import { fetchReleaseGroupCoverUrl } from "./releaseGroupCoverService.js";
import { logger } from "./logger.js";

/**
 * Resolved-art cache keyed by release-group MBID. Cover Art Archive bytes have
 * their own cache inside apiClients/coverArtArchive.js; this one memoizes the
 * winning tier so an album download of 15 tracks resolves art once.
 */
const resolvedCoverCache = createCache(3600);

/**
 * In-flight fetches keyed by mbid (singleflight). When N parallel tracks of the
 * same album resolve the same mbid before the first fetch completes, every
 * caller past the first would otherwise hit the network too - 10 duplicate
 * fetches for a 10-track album, and concurrent sidecar writers racing on
 * possibly mixed payloads. The promise is stored BEFORE its first await and
 * deleted in `finally`, so the map only ever dedupes concurrent calls and can
 * never grow past the number of in-flight fetches.
 */
const inFlightCoverFetches = new Map();

const defaultResolveUrl = fetchReleaseGroupCoverUrl;

/**
 * Download the bytes behind a resolved cover URL. Same timeout, size ceiling and
 * magic-byte validation as the Cover Art Archive tier.
 *
 * @returns {Promise<{bytes: Buffer, mime: string}|null>}
 */
const defaultFetchBytes = async (imageUrl) => {
  const result = await fetchCoverImageBytes(imageUrl);
  return result.bytes?.length ? { bytes: result.bytes, mime: result.mime } : null;
};

const normalizeFetchedBytes = (fetched) => {
  const bytes = Buffer.isBuffer(fetched)
    ? fetched
    : Buffer.isBuffer(fetched?.bytes)
      ? fetched.bytes
      : null;
  if (!bytes?.length) return null;
  const mime = sniffImageMimeType(bytes) || fetched?.mime || null;
  if (!mime) return null;
  return { bytes, mime };
};

/**
 * Run the tier chain for one mbid and (when cacheable) memoize the winner.
 * Extracted so `resolveCoverArtBytes` can wrap it in the singleflight map.
 * Never rejects: every failure is caught and surfaced as `null`.
 */
async function fetchCoverArtBytes(
  mbid,
  { resolveUrl, fetchBytes, fetchCaa, logTag, signal },
  cacheable,
) {
  try {
    const caa = await fetchCaa(mbid, { signal });
    const caaArt = normalizeFetchedBytes(caa);
    if (caaArt) {
      const result = { ...caaArt, source: "caa" };
      if (cacheable) resolvedCoverCache.set(mbid, result);
      return result;
    }

    const resolved = await resolveUrl(mbid);
    const imageUrl =
      typeof resolved === "string" ? resolved : String(resolved?.imageUrl || "").trim();
    if (!imageUrl) return null;

    const urlArt = normalizeFetchedBytes(await fetchBytes(imageUrl));
    if (!urlArt) return null;
    const result = { ...urlArt, source: "url-chain" };
    if (cacheable) resolvedCoverCache.set(mbid, result);
    return result;
  } catch (error) {
    logger.warn(logTag, "Cover art resolution failed", {
      mbid,
      error: error?.message || String(error),
    });
    return null;
  }
}

/**
 * Resolve cover art bytes for a MusicBrainz release group.
 *
 * Tier order:
 *   1. Cover Art Archive front image (`source: "caa"`).
 *   2. The existing release-group cover URL chain - brainzmash/Lidarr/Deezer via
 *      releaseGroupCoverService - then a direct download of that URL
 *      (`source: "url-chain"`).
 *
 * Never throws: cover art is best-effort enrichment and must not be able to fail
 * a download. All network access is injectable so tests stay offline.
 *
 * Concurrent calls for the same mbid are deduped through an in-flight promise
 * map (singleflight): the whole album's tracks resolving at once trigger ONE
 * network fetch, and every concurrent caller receives the same result object.
 * The TTL cache is unchanged - it still only memoizes when the real clients are
 * in play, so injected fakes are never swallowed.
 *
 * @param {string} releaseGroupMbid
 * @param {object} [options]
 * @param {(mbid: string) => Promise<{imageUrl: string|null, notFound?: boolean, transientError?: boolean}|null>} [options.resolveUrl]
 * @param {(imageUrl: string) => Promise<{bytes: Buffer, mime?: string}|Buffer|null>} [options.fetchBytes]
 * @param {(mbid: string, options?: {signal?: AbortSignal}) => Promise<{bytes: Buffer|null, mime: string|null, notFound: boolean, transientError: boolean}>} [options.fetchCaa]
 * @param {string} [options.logTag]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{bytes: Buffer, mime: string, source: "caa"|"url-chain"}|null>}
 */
export async function resolveCoverArtBytes(
  releaseGroupMbid,
  {
    resolveUrl = defaultResolveUrl,
    fetchBytes = defaultFetchBytes,
    fetchCaa = fetchCoverArtArchiveFront,
    logTag = "cover-art",
    signal,
  } = {},
) {
  const mbid = String(releaseGroupMbid || "").trim();
  if (!mbid) return null;

  // Only memoize when running the real clients: injected fakes are per-call
  // behaviour that a shared cache would silently swallow.
  const cacheable =
    resolveUrl === defaultResolveUrl &&
    fetchBytes === defaultFetchBytes &&
    fetchCaa === fetchCoverArtArchiveFront;
  if (cacheable) {
    const cached = resolvedCoverCache.get(mbid);
    if (cached?.bytes?.length) return cached;
  }

  // Singleflight: a second concurrent caller for the same mbid joins the
  // in-flight promise instead of starting a duplicate fetch. The entry is
  // stored synchronously (before the impl's first await) and removed once the
  // promise settles, so it never outlives the fetch it tracks.
  const inFlight = inFlightCoverFetches.get(mbid);
  if (inFlight) return inFlight;

  const promise = fetchCoverArtBytes(
    mbid,
    { resolveUrl, fetchBytes, fetchCaa, logTag, signal },
    cacheable,
  ).finally(() => {
    inFlightCoverFetches.delete(mbid);
  });
  inFlightCoverFetches.set(mbid, promise);
  return promise;
}

export { resolvedCoverCache, inFlightCoverFetches };
