import axios from "../../../lib/axiosFetch.js";
import createRateLimiter from "./rateLimiter.js";
import createCache from "./simpleCache.js";
import { dbOps } from "../../db/helpers/index.js";

const COVER_ART_ARCHIVE_API = "https://coverartarchive.org";

/**
 * Cache namespace for release-group front art. Mirrors the `rg:` namespace used
 * by releaseGroupCoverService so the two never collide in `images_cache`.
 */
const CAA_CACHE_PREFIX = "caa:rg:";

/**
 * Sentinel persisted through dbOps.setImage for release groups Cover Art Archive
 * does not have art for. Same convention as releaseGroupCoverService's
 * `NOT_FOUND` marker, so a missing album is not re-requested on every download.
 */
const NOT_FOUND_SENTINEL = "NOT_FOUND";

/** Hard ceiling for a single cover art request; art larger than this is not usable. */
export const COVER_ART_TIMEOUT_MS = 10000;
export const COVER_ART_MAX_CONTENT_LENGTH = 15 * 1024 * 1024;

// Cover Art Archive asks for ~1 req/s; stay well under it because a failed
// download pipeline retries.
const caaLimiter = createRateLimiter(500);

// Bytes are cached in memory only: the sqlite image cache stores URLs, not blobs.
const caaImageCache = createCache(3600);

const buildEmptyResult = ({ notFound = false, transientError = false } = {}) => ({
  bytes: null,
  mime: null,
  notFound,
  transientError,
});

/**
 * Identify an image payload by its magic bytes. Cover art is handed straight to
 * ffmpeg and to `cover.jpg` sidecars, so an HTML error page or a truncated body
 * must never be mistaken for art.
 *
 * @param {Buffer|Uint8Array|null} bytes
 * @returns {"image/jpeg"|"image/png"|null}
 */
export function sniffImageMimeType(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) return null;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  return null;
}

const toBuffer = (data) => {
  if (Buffer.isBuffer(data)) return data;
  if (data == null) return Buffer.alloc(0);
  return Buffer.from(data);
};

/**
 * GET an image URL and validate it is really jpeg/png art. Shared by the Cover
 * Art Archive client and the URL-chain tier in coverArtService so both enforce
 * identical timeout, size and magic-byte rules.
 *
 * @returns {Promise<{bytes: Buffer|null, mime: string|null, notFound: boolean, transientError: boolean}>}
 */
export async function fetchCoverImageBytes(imageUrl, { signal } = {}) {
  const url = String(imageUrl || "").trim();
  if (!url) return buildEmptyResult({ notFound: true });
  try {
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: COVER_ART_TIMEOUT_MS,
      maxContentLength: COVER_ART_MAX_CONTENT_LENGTH,
      maxRedirects: 5,
      signal,
    });
    const bytes = toBuffer(response?.data);
    const mime = sniffImageMimeType(bytes);
    // A 200 that is not art (error page, empty body) is retryable, not "absent".
    if (!mime) return buildEmptyResult({ transientError: true });
    return { bytes, mime, notFound: false, transientError: false };
  } catch (error) {
    const status = Number(error?.response?.status || 0);
    if (status === 404) return buildEmptyResult({ notFound: true });
    return buildEmptyResult({ transientError: true });
  }
}

const readNotFoundSentinel = (cacheKey) => {
  try {
    return dbOps.getImage(cacheKey)?.imageUrl === NOT_FOUND_SENTINEL;
  } catch {
    return false;
  }
};

const writeNotFoundSentinel = (cacheKey) => {
  try {
    dbOps.setImage(cacheKey, NOT_FOUND_SENTINEL);
  } catch {
    // A read-only or busy database must not turn into a failed download.
  }
};

/**
 * Fetch the front cover for a MusicBrainz RELEASE GROUP from Cover Art Archive.
 *
 * Uses the documented extension-less `front-1200` path (CAA redirects it to the
 * actual image file), so the redirect chain has to be followed. Never throws:
 * callers treat cover art as best-effort and must not fail a download over it.
 *
 * @param {string} releaseGroupMbid MusicBrainz release-group MBID
 * @returns {Promise<{bytes: Buffer|null, mime: string|null, notFound: boolean, transientError: boolean}>}
 */
export async function fetchCoverArtArchiveFront(releaseGroupMbid, { signal } = {}) {
  const mbid = String(releaseGroupMbid || "").trim();
  if (!mbid) return buildEmptyResult({ notFound: true });

  const cacheKey = `${CAA_CACHE_PREFIX}${mbid}`;
  const cached = caaImageCache.get(cacheKey);
  if (cached?.bytes?.length) {
    return {
      bytes: cached.bytes,
      mime: cached.mime,
      notFound: false,
      transientError: false,
    };
  }
  if (readNotFoundSentinel(cacheKey)) return buildEmptyResult({ notFound: true });

  try {
    const result = await caaLimiter.schedule(
      () =>
        fetchCoverImageBytes(
          `${COVER_ART_ARCHIVE_API}/release-group/${encodeURIComponent(mbid)}/front-1200`,
          { signal },
        ),
      { signal },
    );
    if (result.bytes?.length) {
      caaImageCache.set(cacheKey, { bytes: result.bytes, mime: result.mime });
    } else if (result.notFound) {
      writeNotFoundSentinel(cacheKey);
    }
    return result;
  } catch {
    // Aborted signal, rate-limiter deadline, or an unexpected client error.
    return buildEmptyResult({ transientError: true });
  }
}

export { CAA_CACHE_PREFIX, NOT_FOUND_SENTINEL, caaImageCache };
