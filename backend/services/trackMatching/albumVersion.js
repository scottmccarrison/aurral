// Album edition/version detection and release-tracklist evidence for the
// post-download identity policy.
//
// Deluxe/standard editions renumber tracks: "Calico Creek (Acoustic)" can be
// track 15 on the standard edition and track 34 on the deluxe edition. When a
// downloaded file's album tag names a different edition than the job's album,
// the job's track numbering (and its albumTrackTitles list) is the wrong
// space to validate the file's claimed track number against. This module
// provides:
//
//   detectAlbumVersion()        — edition token sets for both album names
//   albumNamesVariant()         — same base album, different edition tokens
//   confirmEditionRenumbering() — per-medium tracklist position check
//   fetchReleaseTracklist()     — cached, never-throwing MusicBrainz release
//                                 tracklist fetch (per-medium numbering)
//
// All detection helpers are pure. The fetcher lazily imports the MusicBrainz
// API client so this module (and everything that imports it, including the
// post-download validator) stays loadable in DB-free unit tests.

import { extractVariants, getCoreTitle } from "./semanticPolicy.js";
import { getNormalizedText } from "../providers/brainzmashRanking.js";

const MBID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Edition tokens, word-boundary aware. "remaster" is deliberately NOT
// duplicated here: semanticPolicy.js already owns the remaster(ed) regex and
// extractVariants() is reused below so the two layers can never drift.
const EDITION_TOKEN_PATTERNS = [
  { token: "deluxe", pattern: /\bdeluxe\b/i },
  { token: "expanded", pattern: /\bexpanded\b/i },
  { token: "anniversary", pattern: /\banniversary\b/i },
  { token: "bonus", pattern: /\bbonus\b/i },
  { token: "special_edition", pattern: /\bspecial\s+edition\b/i },
  { token: "tour_edition", pattern: /\btour\s+edition\b/i },
];

// Same pattern semanticPolicy.js uses for the remaster variant, kept here
// only for stripping (detection goes through extractVariants).
const REMASTER_STRIP_PATTERN = /\b(?:re-?master(?:ed)?|20\d\d\s*re-?master)\b/gi;

const UNKNOWN_VERSION = "unknown";
const STANDARD_VERSION = "standard";

/**
 * Extracts the normalized edition-token set from an album name.
 * @param {string|null|undefined} albumName
 * @returns {Set<string>} tokens such as "deluxe", "special_edition", "remaster"
 */
export function extractEditionTokens(albumName) {
  const text = String(albumName || "");
  const tokens = new Set();
  for (const { token, pattern } of EDITION_TOKEN_PATTERNS) {
    if (pattern.test(text)) tokens.add(token);
  }
  // Reuse the semantic policy's remaster(ed) regex instead of duplicating it.
  if (extractVariants(text).remaster) tokens.add("remaster");
  return tokens;
}

function versionLabel(albumText, tokens) {
  if (!albumText) return UNKNOWN_VERSION;
  return tokens.size > 0 ? [...tokens].sort().join("+") : STANDARD_VERSION;
}

function sameTokenSet(left, right) {
  return (
    left.size === right.size &&
    [...left].every((token) => right.has(token))
  );
}

/**
 * Compares the edition of the requested album with the edition the candidate
 * (downloaded file / search result) claims. A missing candidate album name is
 * "unknown" — NOT "standard" — because absence of evidence must not assert
 * the file belongs to the standard edition.
 *
 * @param {string|null|undefined} requestAlbum
 * @param {string|null|undefined} candidateAlbum may be null → "unknown"
 * @returns {{matches: boolean, requestVersion: string, candidateVersion: string, candidateUnknown: boolean}}
 *   `matches` is true only when both sides are known and their edition token
 *   sets are equal.
 */
export function detectAlbumVersion(requestAlbum, candidateAlbum) {
  const requestText = String(requestAlbum || "").trim();
  const candidateText = String(candidateAlbum || "").trim();
  const candidateUnknown = candidateText === "";
  const requestTokens = extractEditionTokens(requestText);
  const candidateTokens = extractEditionTokens(candidateText);
  const requestVersion = versionLabel(requestText, requestTokens);
  const candidateVersion = versionLabel(candidateText, candidateTokens);
  return {
    matches:
      requestText !== "" &&
      !candidateUnknown &&
      sameTokenSet(requestTokens, candidateTokens),
    requestVersion,
    candidateVersion,
    candidateUnknown,
  };
}

// Album name with edition tokens removed, normalized with the same text
// normalization the matcher uses, so "Calico Creek (Deluxe)" and
// "Calico Creek" collapse to the same base name.
function stripEditionTokens(albumName) {
  let text = String(albumName || "");
  for (const { pattern } of EDITION_TOKEN_PATTERNS) {
    text = text.replace(new RegExp(pattern.source, "gi"), " ");
  }
  text = text.replace(REMASTER_STRIP_PATTERN, " ");
  // Leftover bare "edition" words ("Deluxe Edition" → "Edition") carry no
  // base-name identity once the phrase tokens above are removed.
  text = text.replace(/\beditions?\b/gi, " ");
  return getNormalizedText(text);
}

/**
 * True when both album names are known, share the same normalized base name
 * once edition tokens are ignored, and differ in their edition token sets —
 * e.g. "Calico Creek (Deluxe)" vs "Calico Creek" → true variant. Identical
 * names (equal token sets) are NOT variants of each other.
 *
 * @param {string|null|undefined} requestAlbum
 * @param {string|null|undefined} candidateAlbum
 * @returns {boolean}
 */
export function albumNamesVariant(requestAlbum, candidateAlbum) {
  const requestText = String(requestAlbum || "").trim();
  const candidateText = String(candidateAlbum || "").trim();
  if (!requestText || !candidateText) return false;
  const requestBase = stripEditionTokens(requestText);
  const candidateBase = stripEditionTokens(candidateText);
  if (!requestBase || !candidateBase) return false;
  if (requestBase !== candidateBase) return false;
  return !sameTokenSet(
    extractEditionTokens(requestText),
    extractEditionTokens(candidateText),
  );
}

/**
 * Confirms an edition-renumbering claim against the tracklist of the FILE's
 * own release: the entry at (discNumber, trackNumber) — per-medium, disc-local
 * numbering exactly as tagged — must carry the file's actual title, compared
 * with the same normalization the matcher uses (core title + normalized text).
 *
 * @param {object} params
 * @param {Array<{discNumber: number, trackNumber: number, title: string}>} params.tracklist
 * @param {number|null} params.discNumber file's common.disc.no (null → disc 1)
 * @param {number|null} params.trackNumber file's common.track.no (disc-local)
 * @param {string|null} params.fileTitle file's actual title tag
 * @returns {boolean}
 */
export function confirmEditionRenumbering({
  tracklist,
  discNumber,
  trackNumber,
  fileTitle,
}) {
  if (!Array.isArray(tracklist) || tracklist.length === 0) return false;
  const fileTitleKey = getNormalizedText(getCoreTitle(fileTitle));
  if (!fileTitleKey) return false;
  const disc =
    Number.isFinite(Number(discNumber)) && Number(discNumber) > 0
      ? Math.round(Number(discNumber))
      : 1;
  const track =
    Number.isFinite(Number(trackNumber)) && Number(trackNumber) > 0
      ? Math.round(Number(trackNumber))
      : null;
  if (track == null) return false;
  return tracklist.some(
    (entry) =>
      Number(entry?.discNumber) === disc &&
      Number(entry?.trackNumber) === track &&
      getNormalizedText(getCoreTitle(entry?.title)) === fileTitleKey,
  );
}

const releaseTracklistCache = new Map();
const MAX_CACHE_ENTRIES = 500;

// FIFO eviction, mirrors weeklyFlowTrackResolver.js's bounded cache pattern
// (promise cached first to dedupe concurrent fetches, then the resolved value).
function boundedCacheSet(cache, key, value) {
  if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(key)) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, value);
}

/**
 * Fetches the per-medium tracklist of a MusicBrainz RELEASE (not release
 * group). Read-only, rate-limited by the shared MusicBrainz client, bounded
 * timeout, cached, and NEVER throws: any failure (bad MBID, network, timeout,
 * unexpected shape) resolves to null so callers can relax instead of failing
 * a download validation.
 *
 * @param {string} releaseMbid the file's musicbrainz_albumid tag
 * @returns {Promise<Array<{discNumber: number, trackNumber: number, title: string}>|null>}
 */
export async function fetchReleaseTracklist(releaseMbid) {
  const key = String(releaseMbid || "").trim().toLowerCase();
  if (!MBID_PATTERN.test(key)) return null;
  if (releaseTracklistCache.has(key)) {
    return releaseTracklistCache.get(key);
  }
  const promise = (async () => {
    try {
      // Lazy import on purpose: the MusicBrainz API client pulls DB helpers in
      // at module load, and the post-download validator must stay importable
      // in DB-free tests (same reason the validator never imports dbOps).
      const { musicbrainzGetReleaseTracklist } = await import(
        "../apiClients/musicbrainz.js"
      );
      const tracklist = await musicbrainzGetReleaseTracklist(key);
      return Array.isArray(tracklist) && tracklist.length > 0 ? tracklist : null;
    } catch {
      return null;
    }
  })();
  boundedCacheSet(releaseTracklistCache, key, promise);
  const resolved = await promise;
  boundedCacheSet(releaseTracklistCache, key, resolved);
  return resolved;
}

// Test helper: drops every cached tracklist (including negative results).
export function clearReleaseTracklistCache() {
  releaseTracklistCache.clear();
}
