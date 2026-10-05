import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import { parseFile } from "music-metadata";
import { dbOps } from "../db/helpers/index.js";
import {
  fillLibraryAlbumMbids,
  getLibraryMetadataGapCounts,
  selectLibraryMetadataGapRows,
  updateLibraryMediaArtFlags,
} from "./libraryMediaStore.js";
import { detectSidecarArt } from "./libraryFileScanner.js";
import { parseAurralIdentityComment } from "./playlistDownloadUtils.js";
import { sniffImageMimeType } from "./apiClients/coverArtArchive.js";
import {
  musicbrainzGetRecordingReleases,
  musicbrainzSearchReleaseGroup,
} from "./apiClients/musicbrainz.js";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

const LOG_CATEGORY = "metadata-repair";
const DEFAULT_BATCH_LIMIT = 200;
const YIELD_EVERY_FILES = 25;
// Sidecar names the sweep is allowed to create. Must stay a subset of the
// scanner's SIDECAR_ART_FILENAMES or a written sidecar would never clear the
// has_sidecar_art gap.
const SIDECAR_ART_TARGETS = ["cover.jpg", "folder.jpg"];

// ffmpeg codec name per image mime. Mirrors playlistDownloadUtils'
// COVER_CODEC_BY_MIME so the fallback embedder and the shared `writeAudioCover`
// produce identical attached-picture streams.
const COVER_CODEC_BY_MIME = { "image/jpeg": "mjpeg", "image/png": "png" };

// Cover payloads larger than this are rejected before they reach ffmpeg or
// disk. Mirrors the CAA client's 15MB download cap.
const MAX_COVER_BYTES = 15 * 1024 * 1024;

/**
 * Temp-file name stamp. pid + millisecond clock alone can collide when two
 * writes start in the same process within the same millisecond, so a short
 * random segment is appended.
 */
const tempStamp = () => `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

const text = (value) => String(value ?? "").trim();

const emptyMetrics = () => ({
  filesScanned: 0,
  mbidsFilled: 0,
  artEmbedded: 0,
  sidecarsWritten: 0,
  skipped: 0,
  unresolved: 0,
  errors: [],
});

/** 0, negative, NaN and non-integers all fall back to the documented default. */
export function normalizeRepairBatchLimit(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_BATCH_LIMIT;
}

/**
 * Strict name comparison: lowercase, strip diacritics, collapse whitespace.
 * Deliberately NOT fuzzy - no token overlap, no edition-token stripping, no
 * distance metric. A fuzzy MBID is worse than a missing one.
 */
export function normalizeNameForMatch(value) {
  return text(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const isAlbumType = (value) => text(value).toLowerCase() === "album";

const releaseTrackCount = (release) => {
  const raw = release?.["track-count"] ?? release?.trackCount ?? release?.["medium-track-count"];
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
};

const fullArtistCredit = (releaseGroup) => {
  const credit = Array.isArray(releaseGroup?.["artist-credit"]) ? releaseGroup["artist-credit"] : [];
  return credit
    .map((entry) => `${text(entry?.name)}${text(entry?.joinphrase)}`)
    .join("");
};

/**
 * Resolve an album MBID for one file using STRICT matching only.
 *
 * (a) recording MBID present -> /ws/2/recording/{mbid}?inc=releases. Keep only
 *     primary-type Album releases whose title matches the file's album exactly
 *     after normalization (release title or release-group title) and whose
 *     track count agrees when both sides know it. Prefer status Official.
 *     Exactly one survivor wins; zero or several are unresolved.
 * (b) otherwise -> /ws/2/release-group?query=... accepting only an exact
 *     normalized match on BOTH artist and album plus primary-type Album.
 *
 * Returns `{ albumMbid, releaseGroupMbid, via }` or `null`. Never throws.
 */
export async function resolveStrictAlbumMbid(target = {}, {
  getRecordingReleases = musicbrainzGetRecordingReleases,
  searchReleaseGroup = musicbrainzSearchReleaseGroup,
} = {}) {
  const recordingMbid = text(target.recordingMbid);
  const wantedAlbum = normalizeNameForMatch(target.albumName);
  const wantedArtist = normalizeNameForMatch(target.artistName);
  const wantedTrackCount = Number(target.trackCount) > 0 ? Math.trunc(Number(target.trackCount)) : null;

  if (recordingMbid) {
    const releases = await getRecordingReleases(recordingMbid).catch(() => []);
    const candidates = (Array.isArray(releases) ? releases : []).filter((release) => {
      const group = release?.["release-group"] || {};
      if (!isAlbumType(group["primary-type"])) return false;
      if (wantedAlbum) {
        const titles = [
          normalizeNameForMatch(release?.title),
          normalizeNameForMatch(group?.title),
        ];
        if (!titles.includes(wantedAlbum)) return false;
      }
      const releaseTracks = releaseTrackCount(release);
      if (wantedTrackCount && releaseTracks && releaseTracks !== wantedTrackCount) return false;
      return true;
    });
    const official = candidates.filter(
      (release) => text(release?.status).toLowerCase() === "official",
    );
    const survivors = official.length > 0 ? official : candidates;
    if (survivors.length !== 1) return null;
    const albumMbid = text(survivors[0]?.id) || null;
    const releaseGroupMbid = text(survivors[0]?.["release-group"]?.id) || null;
    if (!albumMbid && !releaseGroupMbid) return null;
    return { albumMbid, releaseGroupMbid, via: "recording-releases" };
  }

  if (!wantedArtist || !wantedAlbum) return null;
  const groups = await searchReleaseGroup(text(target.artistName), text(target.albumName))
    .catch(() => []);
  const matches = (Array.isArray(groups) ? groups : []).filter((group) => {
    if (!isAlbumType(group?.["primary-type"])) return false;
    if (normalizeNameForMatch(group?.title) !== wantedAlbum) return false;
    const credit = Array.isArray(group?.["artist-credit"]) ? group["artist-credit"] : [];
    if (normalizeNameForMatch(fullArtistCredit(group)) === wantedArtist) return true;
    // A single credit may be spelled differently from the canonical artist name.
    return credit.length === 1 && normalizeNameForMatch(credit[0]?.artist?.name) === wantedArtist;
  });
  if (matches.length !== 1) return null;
  const releaseGroupMbid = text(matches[0]?.id) || null;
  if (!releaseGroupMbid) return null;
  return { albumMbid: null, releaseGroupMbid, via: "release-group-search" };
}

// ffmpeg -metadata key -> reader for the current value. Restricted to fields the
// sweep may fill; anything else is refused so a repair can never rewrite tags it
// does not own.
const FILLABLE_TAGS = {
  musicbrainz_albumid: (common, identity) => common.musicbrainz_albumid || identity.albumMbid,
  // The AURRAL_IDS `albumMbid` is release-GROUP level, but it is the job's
  // identity, not this tag's value: the repair path resolves a distinct
  // releaseGroupMbid, so only the file's own tag (or an explicitly recorded
  // identity releaseGroupMbid) proves the group id is present. Falling back to
  // identity.albumMbid here would report a genuinely missing tag as filled,
  // the sweep would never write it, and the row would be stuck as a permanent
  // gap (the store reconcile reads the tag, not the identity).
  musicbrainz_releasegroupid: (common, identity) =>
    common.musicbrainz_releasegroupid || identity.releaseGroupMbid,
  musicbrainz_recordingid: (common, identity) => common.musicbrainz_recordingid || identity.trackMbid,
  musicbrainz_trackid: (common, identity) => common.musicbrainz_trackid || identity.trackMbid,
  musicbrainz_artistid: (common, identity) => common.musicbrainz_artistid || identity.artistMbid,
  musicbrainz_albumartistid: (common, identity) =>
    common.musicbrainz_albumartistid || identity.artistMbid,
  title: (common) => common.title,
  artist: (common) => common.artist,
  album: (common) => common.album,
  album_artist: (common) => common.albumartist,
};

const readEmbeddedIdentity = (common) =>
  Object.assign(
    {},
    parseAurralIdentityComment(common?.comment) || {},
    parseAurralIdentityComment(common?.grouping) || {},
  );

/** True when a tag already holds a non-empty value - such a tag is never touched. */
export function hasTagValue(common, tagKey) {
  const reader = FILLABLE_TAGS[tagKey];
  if (!reader) return true; // unknown key: treat as present so it is skipped
  return text(reader(common || {}, readEmbeddedIdentity(common))) !== "";
}

/**
 * Atomic temp+rename tag write, identical in shape to `writeAudioMetadata`.
 * The temp file is renamed ONTO the source path, so the audio file itself is
 * never renamed or moved.
 */
async function writeTagsAtomic(filePath, tags) {
  const sourcePath = path.resolve(filePath);
  const ext = path.extname(sourcePath) || ".m4a";
  const taggedPath = path.join(
    path.dirname(sourcePath),
    `.${path.basename(sourcePath, ext)}.${tempStamp()}.tagged${ext}`,
  );
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-i",
    sourcePath,
    "-map",
    "0",
    "-c",
    "copy",
  ];
  for (const [key, value] of Object.entries(tags)) args.push("-metadata", `${key}=${value}`);
  args.push(taggedPath);
  try {
    await execFileAsync("ffmpeg", args, { timeout: 120000 });
    // Data-loss guard: an empty (or missing) output must never replace the
    // original. Thrown inside the try so the existing temp cleanup runs and
    // the error keeps this function's message shape.
    const tagged = await fs.stat(taggedPath).catch(() => null);
    if (!tagged || tagged.size === 0) throw new Error("ffmpeg produced empty output");
    await fs.rename(taggedPath, sourcePath);
    return sourcePath;
  } catch (error) {
    await fs.rm(taggedPath, { force: true }).catch(() => {});
    const detail = text(error?.stderr || error?.message || error).slice(-500);
    throw new Error(`Failed to write audio metadata: ${detail}`);
  }
}

/**
 * Merge-only tag write: reads the current tags first and keeps only the fields
 * that are genuinely missing. Existing non-empty values ALWAYS win, matching
 * `repairYtdlpMetadata`'s semantics. Returns which keys were actually applied.
 */
export async function writeMissingTags(filePath, tags = {}, { parse = parseFile } = {}) {
  const current = await parse(filePath, { skipCovers: true });
  const common = current?.common || {};
  const applied = {};
  for (const [key, value] of Object.entries(tags)) {
    const next = text(value);
    if (!next) continue;
    if (hasTagValue(common, key)) continue;
    applied[key] = next;
  }
  if (Object.keys(applied).length === 0) return { written: false, applied };
  await writeTagsAtomic(filePath, applied);
  return { written: true, applied };
}

const mimeExtension = (mimeType) => {
  const value = text(mimeType).toLowerCase();
  if (value.includes("png")) return ".png";
  if (value.includes("webp")) return ".webp";
  if (value.includes("gif")) return ".gif";
  return ".jpg";
};

/** Fallback embedder used when `writeAudioCover` is not available. */
async function embedCoverArtWithFfmpeg(filePath, bytes, { mimeType = "image/jpeg" } = {}) {
  const sourcePath = path.resolve(filePath);
  const ext = path.extname(sourcePath) || ".m4a";
  const dir = path.dirname(sourcePath);
  const stamp = tempStamp();
  // Sniffed magic bytes win over the declared mime, exactly as in
  // writeAudioCover: a resolver can mislabel a payload, and the codec below has
  // to match what ffmpeg is really being fed.
  const resolvedMime =
    sniffImageMimeType(bytes) || text(mimeType).toLowerCase() || "image/jpeg";
  const codec = COVER_CODEC_BY_MIME[resolvedMime] || "mjpeg";
  const coverPath = path.join(dir, `.aurral-cover-${stamp}${mimeExtension(resolvedMime)}`);
  const taggedPath = path.join(dir, `.${path.basename(sourcePath, ext)}.${stamp}.art${ext}`);
  await fs.writeFile(coverPath, bytes);
  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-i",
        sourcePath,
        "-i",
        coverPath,
        "-map",
        "0",
        "-map",
        "1",
        "-c",
        "copy",
        // The audio source has no video stream, so the attached image is v:0.
        // Without an explicit codec ffmpeg auto-selects one for the picture
        // stream, which either fails or yields art players will not recognise.
        "-c:v:0",
        codec,
        "-disposition:v:0",
        "attached_pic",
        "-metadata:s:v:0",
        "title=Album cover",
        "-metadata:s:v:0",
        "comment=Cover (front)",
        taggedPath,
      ],
      { timeout: 120000 },
    );
    // Data-loss guard: an empty (or missing) output must never replace the
    // original. Thrown inside the try so the existing temp cleanup runs and
    // the error keeps this function's message shape.
    const embedded = await fs.stat(taggedPath).catch(() => null);
    if (!embedded || embedded.size === 0) throw new Error("ffmpeg produced empty output");
    await fs.rename(taggedPath, sourcePath);
    return true;
  } catch (error) {
    await fs.rm(taggedPath, { force: true }).catch(() => {});
    const detail = text(error?.stderr || error?.message || error).slice(-500);
    throw new Error(`Failed to embed cover art: ${detail}`);
  } finally {
    await fs.rm(coverPath, { force: true }).catch(() => {});
  }
}

// Both helpers live on branches that may not have landed yet, so they are
// resolved lazily and degrade to "unavailable" instead of throwing.
let coverWriterPromise = null;
const loadCoverWriter = () => {
  coverWriterPromise ??= import("./playlistDownloadUtils.js")
    .then((module) => (typeof module.writeAudioCover === "function" ? module.writeAudioCover : null))
    .catch(() => null);
  return coverWriterPromise;
};

let coverResolverPromise = null;
const loadDefaultCoverResolver = () => {
  coverResolverPromise ??= import("./coverArtService.js")
    .then((module) =>
      typeof module.resolveCoverArtBytes === "function" ? module.resolveCoverArtBytes : null,
    )
    .catch(() => null);
  return coverResolverPromise;
};

/** Which embedder this run used - reported so the parallel-branch handoff is visible. */
export async function resolveCoverEmbedder() {
  const shared = await loadCoverWriter();
  if (!shared) return { name: "ffmpeg", embed: embedCoverArtWithFfmpeg };
  // `writeAudioCover` is the canonical embedder, but its shape is
  // (filePath, {bytes, mime}, {embed, sidecar, sidecarDir}) while the fallback
  // takes (filePath, bytes, {mimeType}). Adapt it so the sweep keeps one call
  // site, and leave sidecars off: the sweep writes and counts them itself so
  // the `wx` fill-only accounting lives in exactly one place.
  // Returns the writer's own verdict - it is best-effort and never throws, so
  // a skipped or failed embed must not be reported as success.
  return {
    name: "writeAudioCover",
    embed: async (filePath, bytes, { mimeType = null } = {}) => {
      const result = await shared(
        filePath,
        { bytes, mime: mimeType || null },
        { embed: true, sidecar: false },
      );
      return result?.embedded === true;
    },
  };
}

async function resolveCoverBytes(resolver, target) {
  if (typeof resolver !== "function") return null;
  try {
    const resolved = await resolver(target);
    if (!resolved) return null;
    if (Buffer.isBuffer(resolved)) {
      // Size cap: an oversized payload is a broken resolver, not cover art.
      if (resolved.length > MAX_COVER_BYTES) return null;
      return { buffer: resolved, mimeType: "image/jpeg" };
    }
    const raw = resolved.bytes ?? resolved.buffer ?? resolved.data;
    const buffer = Buffer.isBuffer(raw) ? raw : raw ? Buffer.from(raw) : null;
    if (!buffer || buffer.length === 0 || buffer.length > MAX_COVER_BYTES) return null;
    return { buffer, mimeType: text(resolved.mimeType || resolved.contentType) || "image/jpeg" };
  } catch {
    return null;
  }
}

/** `wx` makes this race-safe and fill-only: an existing sidecar is never replaced. */
async function writeSidecarArt(dirPath, bytes) {
  let written = 0;
  for (const name of SIDECAR_ART_TARGETS) {
    try {
      await fs.writeFile(path.join(dirPath, name), bytes, { flag: "wx" });
      written += 1;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  return written;
}

const buildRepairTarget = (row, common, filePath) => ({
  path: filePath,
  filePath,
  artistName:
    text(common.albumartist || common.artist) ||
    text(row.album_artist) ||
    text(row.artist_name),
  albumName: text(common.album) || text(row.album_name),
  recordingMbid: text(common.musicbrainz_recordingid || common.musicbrainz_trackid),
  artistMbid: text(common.musicbrainz_albumartistid || common.musicbrainz_artistid) || text(row.artist_mbid),
  albumMbid: text(common.musicbrainz_albumid) || text(row.album_mbid),
  releaseGroupMbid:
    text(common.musicbrainz_releasegroupid) || text(row.release_group_mbid),
  trackCount: Number(common.track?.of) > 0 ? Math.trunc(Number(common.track.of)) : null,
});

/**
 * Fill-only library metadata repair sweep (issue #14).
 *
 * Gap rows come from SQL over libraryMediaStore - the filesystem is never
 * re-walked here. Nothing is ever overwritten: non-empty tags win, sidecars are
 * written with `wx`, store flags only ratchet upwards, and a fuzzy MBID match is
 * recorded as unresolved rather than written.
 *
 * @param {object} [options]
 * @param {number|null} [options.limit] override the configured batch limit
 * @param {Function|null} [options.resolveCover] cover-art byte resolver (DI; tests inject a fake)
 * @param {Function|null} [options.resolveAlbumMbid] album-MBID resolver (DI; defaults to the strict matcher)
 * @param {number|Function} [options.now] run timestamp
 * @returns {Promise<{filesScanned:number,mbidsFilled:number,artEmbedded:number,sidecarsWritten:number,skipped:number,unresolved:number,errors:Array}>}
 */
export async function repairMetadataGaps({
  limit = null,
  resolveCover = null,
  resolveAlbumMbid = null,
  now = Date.now(),
} = {}) {
  const metrics = emptyMetrics();
  // Settings are hot-read on every run so the kill switch needs no restart.
  const enrichment = dbOps.getSettings()?.enrichment || {};
  const sweepEnabled = enrichment.repairSweepEnabled !== false;
  const fillMbidEnabled = enrichment.repairFillMbid !== false;
  const embedEnabled = enrichment.embedCoverArt !== false;
  const sidecarEnabled = enrichment.sidecarCoverArt !== false;
  const batchLimit = normalizeRepairBatchLimit(enrichment.repairBatchLimit);
  const runAt = typeof now === "function" ? Number(now()) : Number(now);

  if (!sweepEnabled) {
    logger.info(LOG_CATEGORY, "Repair sweep disabled by settings", {
      repairSweepEnabled: false,
      at: Number.isFinite(runAt) ? runAt : Date.now(),
    });
    return metrics;
  }

  const requestedLimit = Number(limit);
  const effectiveLimit =
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.floor(requestedLimit)
      : batchLimit;

  const gapCounts = getLibraryMetadataGapCounts();
  const rows = selectLibraryMetadataGapRows({ limit: effectiveLimit });
  metrics.filesScanned = rows.length;
  // Rows past the batch cap are deferred to the next scheduled run.
  metrics.skipped += Math.max(0, gapCounts.total - rows.length);

  const coverResolver =
    typeof resolveCover === "function" ? resolveCover : await loadDefaultCoverResolver();
  const embedder = embedEnabled ? await resolveCoverEmbedder() : null;

  let processed = 0;
  for (const row of rows) {
    const filePath = text(row.path);
    let acted = false;
    let unresolved = false;
    let skippedFile = false;
    let embeddedNow = Number(row.has_embedded_art) === 1;
    let sidecarNow = Number(row.has_sidecar_art) === 1;
    const detail = { mbidFilled: false, artEmbedded: false, sidecarsWritten: 0 };

    try {
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat?.isFile()) {
        metrics.skipped += 1;
        continue;
      }

      const current = await parseFile(filePath, { skipCovers: true });
      const common = current?.common || {};
      const target = buildRepairTarget(row, common, filePath);

      // --- 1. Album MBID: fill-only, strict matches only -------------------
      const storeMbidGap = !text(row.album_mbid) || !text(row.release_group_mbid);
      if (storeMbidGap) {
        const fileHasBothTags =
          hasTagValue(common, "musicbrainz_albumid") &&
          hasTagValue(common, "musicbrainz_releasegroupid");
        if (!fillMbidEnabled) {
          skippedFile = true;
        } else if (fileHasBothTags) {
          // Tags already complete: reconcile the store, never rewrite the file.
          fillLibraryAlbumMbids({
            albumId: row.album_id,
            mbid: text(common.musicbrainz_albumid),
            releaseGroupMbid: text(common.musicbrainz_releasegroupid),
          });
          skippedFile = true;
        } else {
          const resolved =
            typeof resolveAlbumMbid === "function"
              ? await resolveAlbumMbid(target)
              : await resolveStrictAlbumMbid(target);
          if (resolved && (text(resolved.albumMbid) || text(resolved.releaseGroupMbid))) {
            const tags = {};
            if (text(resolved.albumMbid)) tags.musicbrainz_albumid = text(resolved.albumMbid);
            if (text(resolved.releaseGroupMbid)) {
              tags.musicbrainz_releasegroupid = text(resolved.releaseGroupMbid);
            }
            const write = await writeMissingTags(filePath, tags, { parse: parseFile });
            if (write.written) {
              metrics.mbidsFilled += 1;
              detail.mbidFilled = true;
              acted = true;
              logger.info(LOG_CATEGORY, "Filled album MBID", {
                path: filePath,
                mbid: text(resolved.albumMbid) || text(resolved.releaseGroupMbid),
                via: text(resolved.via) || "unknown",
              });
            } else {
              skippedFile = true;
            }
            fillLibraryAlbumMbids({
              albumId: row.album_id,
              mbid: text(resolved.albumMbid),
              releaseGroupMbid: text(resolved.releaseGroupMbid),
            });
          } else {
            // Zero or multiple strict candidates: leave the file untouched.
            unresolved = true;
          }
        }
      }

      // --- 2. Cover art: fill-only ----------------------------------------
      const wantsEmbed = !embeddedNow && embedEnabled;
      const wantsSidecar = !sidecarNow && sidecarEnabled;
      if (wantsEmbed || wantsSidecar) {
        const cover = await resolveCoverBytes(coverResolver, target);
        if (!cover) {
          unresolved = true;
        } else {
          if (wantsEmbed) {
            // Both embedders report whether art was really attached. The shared
            // writer is best-effort and never throws, so counting blindly would
            // raise the store flag and hide the gap with no art in the file.
            const embedded =
              (await embedder.embed(filePath, cover.buffer, {
                mimeType: cover.mimeType,
              })) === true;
            if (embedded) {
              metrics.artEmbedded += 1;
              detail.artEmbedded = true;
              embeddedNow = true;
              acted = true;
            }
          }
          if (wantsSidecar) {
            const written = await writeSidecarArt(path.dirname(filePath), cover.buffer);
            metrics.sidecarsWritten += written;
            detail.sidecarsWritten = written;
            if (written > 0) acted = true;
            sidecarNow = written > 0 || (await detectSidecarArt(path.dirname(filePath)));
          }
        }
      } else if (!embeddedNow || !sidecarNow) {
        // An art gap exists but the corresponding feature is switched off.
        skippedFile = true;
      }

      // --- 3. Done-marker: raise the store flags, no full re-parse ----------
      if (embeddedNow || sidecarNow) {
        updateLibraryMediaArtFlags({
          source: row.source,
          path: filePath,
          hasEmbeddedArt: embeddedNow,
          hasSidecarArt: sidecarNow,
        });
      }

      if (unresolved) metrics.unresolved += 1;
      else if (!acted) metrics.skipped += 1;
    } catch (error) {
      metrics.errors.push({ path: filePath, message: text(error?.message || error) });
    } finally {
      processed += 1;
      logger.debug(LOG_CATEGORY, "Repair sweep processed file", {
        path: filePath,
        ...detail,
        embeddedNow,
        sidecarNow,
        // `skipped` = a gap existed but was deliberately left alone (feature
        // switched off, or the tag was already present). `unresolved` = we
        // tried and could not resolve it strictly.
        skipped: skippedFile,
        unresolved,
      });
      // Same cooperative-yield cadence as releaseMetadataSync.
      if (processed % YIELD_EVERY_FILES === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }

  logger.info(LOG_CATEGORY, "Repair sweep complete", { ...metrics });
  return metrics;
}

export { SIDECAR_ART_TARGETS, DEFAULT_BATCH_LIMIT };
