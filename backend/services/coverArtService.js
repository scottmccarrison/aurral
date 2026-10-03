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

export { resolvedCoverCache };
