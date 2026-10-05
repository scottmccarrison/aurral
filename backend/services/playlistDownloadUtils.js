import { execFile } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import path from "path";
import fs from "fs/promises";
import { parseFile } from "music-metadata";
import { dbOps } from "../db/helpers/index.js";
import { sniffImageMimeType } from "./apiClients/coverArtArchive.js";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);
const AURRAL_IDENTITY_PREFIX = "AURRAL_IDS=";

// Containers ffmpeg can attach a picture stream to. Anything outside this set is
// sidecar-only: `-c copy` plus an attached_pic video stream is rejected (ogg/opus
// have no mapped picture codec, wav/wma have no tag slot ffmpeg will write).
const EMBEDDABLE_AUDIO_EXTENSIONS = new Set([".mp3", ".flac", ".m4a", ".mp4", ".aac"]);
const SIDECAR_ONLY_AUDIO_EXTENSIONS = new Set([".ogg", ".oga", ".opus", ".wav", ".wma"]);

// *arr / Navidrome convention: Navidrome sniffs sidecar content, so both names
// always carry the bytes we were given regardless of jpeg-vs-png.
// Order matters: Navidrome's CoverArtPriority prefers `cover.*` over
// `folder.*`, so cover.jpg is written FIRST - if the second write fails, the
// surviving file is the higher-priority one.
const SIDECAR_FILENAMES = ["cover.jpg", "folder.jpg"];

// Art already sitting next to a downloaded file (deemix, slskd folder grabs) is
// preferred over a network lookup - it is the art that shipped with the source.
const SOURCE_SIDECAR_FILENAMES = [
  "cover.jpg",
  "cover.png",
  "folder.jpg",
  "front.jpg",
  "front.png",
  "front.jpeg",
];

const COVER_CODEC_BY_MIME = { "image/jpeg": "mjpeg", "image/png": "png" };

// Sidecar cover candidates larger than this are skipped without being read.
// Mirrors the CAA client's 15MB download cap.
const MAX_SIDECAR_COVER_BYTES = 15 * 1024 * 1024;

/**
 * Temp-file name stamp. pid + millisecond clock alone can collide when two
 * writes start in the same process within the same millisecond, so a short
 * random segment is appended.
 */
const tempStamp = () => `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

export function sanitizePathPart(value, fallback = "Unknown") {
  const text = String(value || "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim();
  return text || fallback;
}

export function normalizePositiveInteger(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const normalized = Math.floor(Number(value));
  return normalized > 0 ? normalized : null;
}

export function normalizeStringList(value) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
}

export function parseStringListJson(value) {
  if (!value) return [];
  try {
    return normalizeStringList(JSON.parse(value));
  } catch {
    return [];
  }
}

export function stringifyStringListJson(value) {
  const normalized = normalizeStringList(value);
  return normalized.length > 0 ? JSON.stringify(normalized) : null;
}

export function buildAurralIdentityComment(metadata = {}) {
  const identity = Object.fromEntries(
    ["artistMbid", "albumMbid", "trackMbid"]
      .map((key) => [key, String(metadata?.[key] || "").trim()])
      .filter(([, value]) => value),
  );
  return Object.keys(identity).length > 0
    ? `${AURRAL_IDENTITY_PREFIX}${JSON.stringify(identity)}`
    : null;
}

export function parseAurralIdentityComment(value) {
  const comments = Array.isArray(value) ? value : [value];
  for (const entry of comments) {
    const text = String(typeof entry === "object" ? entry?.text || "" : entry || "").trim();
    if (!text.startsWith(AURRAL_IDENTITY_PREFIX)) continue;
    try {
      const parsed = JSON.parse(text.slice(AURRAL_IDENTITY_PREFIX.length));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return null;
}

export function buildResolvedPlaylistTrack(job, payloadTrack = {}) {
  const track = payloadTrack && typeof payloadTrack === "object" ? payloadTrack : {};
  return {
    artistName: job.artistName || track.artistName,
    trackName: job.trackName || track.trackName,
    albumName: job.albumName || track.albumName,
    artistMbid: job.artistMbid || track.artistMbid,
    albumMbid: job.albumMbid || track.albumMbid,
    trackMbid: job.trackMbid || track.trackMbid,
    releaseYear: job.releaseYear || track.releaseYear,
    durationMs: job.durationMs ?? track.durationMs ?? null,
    trackNumber: normalizePositiveInteger(job.trackNumber ?? track.trackNumber),
    albumTrackCount: normalizePositiveInteger(job.albumTrackCount ?? track.albumTrackCount),
    albumTrackTitles: normalizeStringList(
      (job.albumTrackTitles?.length ? job.albumTrackTitles : null) || track.albumTrackTitles,
    ),
    artistAliases:
      Array.isArray(job.artistAliases) && job.artistAliases.length
        ? job.artistAliases
        : normalizeStringList(track.artistAliases),
    manualReplacementSearch: job.manualReplacementSearch === true,
  };
}

export function resolveBlockedJobSourceFilename(job) {
  const remote = String(job?.remoteFilename || "").trim();
  if (remote) return remote;
  const staging = String(job?.stagingPath || "").trim();
  if (!staging) return null;
  return path.basename(staging) || null;
}

export function joinUnderRoot(root, relativePath, fileName = null) {
  const parts = String(relativePath || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  if (fileName) {
    parts.push(fileName);
  }
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, ...parts);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Destination must remain inside the configured root");
  }
  return resolvedPath;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveAvailableTargetPath(targetPath) {
  if (!(await fileExists(targetPath))) return targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  for (let index = 2; index < 1000; index += 1) {
    const candidate = path.join(dir, `${base} (${index})${ext}`);
    if (!(await fileExists(candidate))) return candidate;
  }
  return path.join(dir, `${base} (${Date.now()})${ext}`);
}

export async function commitImportToPlaylistLibrary(
  sourcePath,
  targetPath,
  { reuseExisting = false } = {},
) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  if (path.resolve(sourcePath) === path.resolve(targetPath)) {
    return targetPath;
  }
  if (reuseExisting) {
    const existing = await fs.stat(targetPath).catch(() => null);
    if (existing?.isFile()) {
      await fs.rm(sourcePath, { force: true });
      return targetPath;
    }
  }
  const resolvedTarget = await resolveAvailableTargetPath(targetPath);
  try {
    await fs.rename(sourcePath, resolvedTarget);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    const tempTarget = path.join(
      path.dirname(resolvedTarget),
      `.aurral-import-${tempStamp()}-${path.basename(resolvedTarget)}.tmp`,
    );
    await fs.copyFile(sourcePath, tempTarget);
    const [sourceStat, tempStat] = await Promise.all([fs.stat(sourcePath), fs.stat(tempTarget)]);
    if (sourceStat.size !== tempStat.size) {
      await fs.rm(tempTarget, { force: true }).catch(() => {});
      throw new Error("Imported file copy did not match source size");
    }
    await fs.rename(tempTarget, resolvedTarget);
    await fs.rm(sourcePath, { force: true });
  }
  return resolvedTarget;
}

export async function writeAudioMetadata(filePath, metadata = {}) {
  const sourcePath = path.resolve(filePath);
  const ext = path.extname(sourcePath) || ".m4a";
  const taggedPath = path.join(
    path.dirname(sourcePath),
    `.${path.basename(sourcePath, ext)}.${tempStamp()}.tagged${ext}`,
  );
  const tags = [
    ["title", metadata.trackName],
    ["artist", metadata.artistName],
    ["album_artist", metadata.artistName],
    ["album", metadata.albumName],
    ["musicbrainz_artistid", metadata.artistMbid],
    ["musicbrainz_albumartistid", metadata.artistMbid],
    ["musicbrainz_albumid", metadata.albumMbid],
    ["musicbrainz_releasegroupid", metadata.albumMbid],
    ["musicbrainz_recordingid", metadata.trackMbid],
    ["musicbrainz_trackid", metadata.trackMbid],
    ["grouping", buildAurralIdentityComment(metadata)],
    ["date", metadata.releaseYear],
    ["track", normalizePositiveInteger(metadata.trackNumber)],
  ].filter(([, value]) => value != null && String(value).trim());
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
  for (const [key, value] of tags) {
    args.push("-metadata", `${key}=${String(value).trim()}`);
  }
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
    const detail = String(error?.stderr || error?.message || error).trim().slice(-500);
    throw new Error(`Failed to write audio metadata: ${detail}`);
  }
}

const errorDetail = (error) =>
  String(error?.stderr || error?.message || error || "").trim().slice(-500);

/**
 * True when the file already carries an attached picture. Embedding is skipped in
 * that case (fill-only) so a re-tag never stacks duplicate covers.
 */
async function hasEmbeddedPicture(filePath) {
  try {
    const { common } = await parseFile(filePath, { skipCovers: false });
    return Array.isArray(common?.picture) && common.picture.length > 0;
  } catch {
    return false;
  }
}

/**
 * Attach `bytes` to the audio file as an attached_pic stream, using the same
 * temp-file + rename + cleanup-on-error convention as writeAudioMetadata.
 */
async function embedCoverArt(sourcePath, { bytes, mime }) {
  const ext = path.extname(sourcePath).toLowerCase();
  const codec = COVER_CODEC_BY_MIME[mime] || "mjpeg";
  const stamp = tempStamp();
  const base = path.basename(sourcePath, ext);
  const coverPath = path.join(
    path.dirname(sourcePath),
    `.${base}.${stamp}.cover${codec === "png" ? ".png" : ".jpg"}`,
  );
  const embeddedPath = path.join(
    path.dirname(sourcePath),
    `.${base}.${stamp}.cover-embedded${ext}`,
  );
  await fs.writeFile(coverPath, bytes);
  const args = [
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
    "-c:v:0",
    codec,
    "-disposition:v:0",
    "attached_pic",
    "-metadata:s:v:0",
    "title=Album cover",
    "-metadata:s:v:0",
    "comment=Cover (front)",
  ];
  if (ext === ".mp3") args.push("-id3v2_version", "3");
  args.push(embeddedPath);
  try {
    await execFileAsync("ffmpeg", args, { timeout: 120000 });
    // Data-loss guard: an empty (or missing) output must never replace the
    // original. Thrown inside the try so the existing temp cleanup runs and
    // the error keeps this function's message shape.
    const embedded = await fs.stat(embeddedPath).catch(() => null);
    if (!embedded || embedded.size === 0) throw new Error("ffmpeg produced empty output");
    await fs.rename(embeddedPath, sourcePath);
    return true;
  } catch (error) {
    await fs.rm(embeddedPath, { force: true }).catch(() => {});
    throw new Error(`Failed to embed cover art: ${errorDetail(error)}`);
  } finally {
    await fs.rm(coverPath, { force: true }).catch(() => {});
  }
}

/**
 * Embed cover art into an audio file and/or write `cover.jpg` + `folder.jpg`
 * sidecars next to it.
 *
 * Best-effort by contract: cover art must never be able to fail a download, so
 * failures are logged and surfaced through the return value instead of thrown.
 * A failed embed still allows the sidecars to be written.
 *
 * @param {string} filePath audio file to embed into (normally the staging file)
 * @param {{bytes: Buffer|Uint8Array, mime?: string|null}} cover
 * @param {object} [options]
 * @param {boolean} [options.embed=true] skip for containers ffmpeg cannot attach
 *   pictures to; the container matrix below decides that, not the caller.
 * @param {boolean} [options.sidecar=true]
 * @param {string|null} [options.sidecarDir] defaults to dirname(filePath). Callers
 *   pass the final library dir because the staging file is moved on commit.
 * @returns {Promise<{embedded: boolean, sidecarsWritten: string[]}>} absolute paths
 *   of the sidecars this call created (pre-existing ones are never overwritten).
 */
export async function writeAudioCover(
  filePath,
  { bytes, mime } = {},
  { embed = true, sidecar = true, sidecarDir = null } = {},
) {
  const result = { embedded: false, sidecarsWritten: [] };
  const coverBytes = Buffer.isBuffer(bytes)
    ? bytes
    : bytes == null
      ? null
      : Buffer.from(bytes);
  if (!coverBytes?.length) return result;

  const sourcePath = path.resolve(filePath);
  // Sniffed magic bytes win over the declared mime: a tier-2 URL can hand back an
  // HTML error page, and that must never be embedded or written as cover.jpg.
  const resolvedMime = sniffImageMimeType(coverBytes);
  if (!resolvedMime) {
    logger.warn("cover-art", "Cover art payload is not a jpeg/png image; skipped", {
      filePath: sourcePath,
      declaredMime: mime || null,
    });
    return result;
  }
  const ext = path.extname(sourcePath).toLowerCase();

  if (embed) {
    if (EMBEDDABLE_AUDIO_EXTENSIONS.has(ext)) {
      try {
        if (await hasEmbeddedPicture(sourcePath)) {
          logger.debug("cover-art", "Audio file already has embedded cover art", {
            extension: ext,
          });
        } else {
          result.embedded = await embedCoverArt(sourcePath, {
            bytes: coverBytes,
            mime: resolvedMime,
          });
        }
      } catch (error) {
        logger.warn("cover-art", "Cover art embed failed; sidecar only", {
          filePath: sourcePath,
          error: errorDetail(error),
        });
      }
    } else if (SIDECAR_ONLY_AUDIO_EXTENSIONS.has(ext)) {
      logger.debug("cover-art", "Container cannot hold an attached picture", {
        extension: ext,
      });
    }
  }

  if (sidecar) {
    const dir = path.resolve(sidecarDir || path.dirname(sourcePath));
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      logger.warn("cover-art", "Cover art sidecar directory unavailable", {
        dir,
        error: errorDetail(error),
      });
      return result;
    }
    for (const name of SIDECAR_FILENAMES) {
      const target = path.join(dir, name);
      try {
        // Exclusive create: existing art is left alone (fill-only, race-safe).
        await fs.writeFile(target, coverBytes, { flag: "wx" });
        result.sidecarsWritten.push(target);
      } catch (error) {
        if (error?.code === "EEXIST") continue;
        logger.warn("cover-art", "Cover art sidecar write failed", {
          target,
          error: errorDetail(error),
        });
      }
    }
  }

  return result;
}

/**
 * Cover-art enrichment switches. Both default ON when the settings block is
 * absent, so installs that predate the setting keep getting art.
 */
function readCoverArtEnrichmentFlags() {
  try {
    const enrichment = dbOps.getSettings?.()?.enrichment;
    return {
      embed: enrichment?.embedCoverArt !== false,
      sidecar: enrichment?.sidecarCoverArt !== false,
    };
  } catch {
    return { embed: true, sidecar: true };
  }
}

/**
 * Tier 0: adopt art that already sits beside the downloaded file (deemix and
 * folder grabs ship their own cover), before spending a network lookup.
 */
async function adoptSourceSidecarCover(stagingPath) {
  const dir = path.dirname(path.resolve(stagingPath));
  for (const name of SOURCE_SIDECAR_FILENAMES) {
    try {
      const candidate = path.join(dir, name);
      // Size gate BEFORE reading: a zero-byte placeholder is not art and an
      // oversized file is corrupt or hostile - neither may reach ffmpeg, the
      // embed path or a sidecar write.
      const stat = await fs.stat(candidate).catch(() => null);
      if (!stat?.isFile() || stat.size === 0 || stat.size > MAX_SIDECAR_COVER_BYTES) continue;
      const bytes = await fs.readFile(candidate);
      const mime = sniffImageMimeType(bytes);
      if (mime) return { bytes, mime, source: "source-sidecar" };
    } catch {
      // Absent or unreadable - try the next candidate name.
    }
  }
  return null;
}

async function resolveTrackCover(resolvedTrack, resolveCover) {
  const mbid = String(resolvedTrack?.albumMbid || "").trim();
  if (!mbid) return null;
  if (typeof resolveCover === "function") return (await resolveCover(mbid)) || null;
  // Lazy: keeps the cover-art client graph (and its network deps) out of modules
  // that only ever tag files.
  const { resolveCoverArtBytes } = await import("./coverArtService.js");
  return (await resolveCoverArtBytes(mbid)) || null;
}

/**
 * Tag a downloaded track, then enrich it with cover art: embedded into the audio
 * file plus `cover.jpg`/`folder.jpg` sidecars in the final library directory.
 *
 * Tags are written first and unconditionally - art is optional enrichment and no
 * art problem (resolve, read, embed or sidecar) may ever fail the download.
 *
 * @param {string} stagingPath file to tag and embed into; it is moved to its
 *   final name by commitImportToPlaylistLibrary afterwards, so embedded art
 *   travels with it.
 * @param {string} finalDir library directory the file will be committed into -
 *   sidecars are written here, not into the staging dir.
 * @param {object} resolvedTrack tag source (see buildResolvedPlaylistTrack)
 * @param {object} [options]
 * @param {{bytes: Buffer, mime?: string, source?: string}|null} [options.cover]
 *   pre-resolved art; pass it to keep network work outside the commit lock.
 * @param {((mbid: string) => Promise<{bytes: Buffer, mime?: string}|null>)|null} [options.resolveCover]
 *   injected resolver, defaults to coverArtService.resolveCoverArtBytes.
 * @returns {Promise<{embedded: boolean, sidecarsWritten: string[]}|null>}
 */
export async function enrichDownloadedTrack(
  stagingPath,
  finalDir,
  resolvedTrack,
  { cover = null, resolveCover = null } = {},
) {
  await writeAudioMetadata(stagingPath, resolvedTrack);
  try {
    const { embed, sidecar } = readCoverArtEnrichmentFlags();
    if (!embed && !sidecar) return null;

    let resolved = null;
    if (cover == null) {
      resolved =
        (await adoptSourceSidecarCover(stagingPath)) ||
        (await resolveTrackCover(resolvedTrack, resolveCover));
    } else if (cover?.bytes?.length) {
      const bytes = Buffer.isBuffer(cover.bytes) ? cover.bytes : Buffer.from(cover.bytes);
      resolved = {
        bytes,
        mime: sniffImageMimeType(bytes) || cover.mime || null,
        source: cover.source || "caller",
      };
    }
    if (!resolved?.bytes?.length) return null;

    return await writeAudioCover(
      stagingPath,
      { bytes: resolved.bytes, mime: resolved.mime },
      {
        embed,
        sidecar,
        // commitImportToPlaylistLibrary moves only the audio file, so sidecars
        // must land in the library dir directly.
        sidecarDir: finalDir ? path.resolve(finalDir) : null,
      },
    );
  } catch (error) {
    logger.warn("cover-art", "Cover art enrichment skipped", {
      stagingPath: String(stagingPath || ""),
      error: errorDetail(error),
    });
    return null;
  }
}

export async function repairYtdlpMetadata(jobs = []) {
  const result = { scanned: 0, repaired: 0, failed: 0 };
  const seen = new Set();
  for (const job of jobs) {
    if (
      job?.status !== "done" ||
      job?.downloadClient !== "ytdlp" ||
      path.extname(job?.finalPath || "").toLowerCase() !== ".m4a"
    ) {
      continue;
    }
    const filePath = path.resolve(job.finalPath);
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    result.scanned += 1;
    try {
      const { common } = await parseFile(filePath, { skipCovers: true });
      const expected = [
        [common.title, job.trackName],
        [common.artist, job.artistName],
        [common.albumartist, job.artistName],
        [common.album, job.albumName],
      ].filter(([, value]) => String(value || "").trim());
      const embeddedIdentity = Object.assign(
        {},
        parseAurralIdentityComment(common.comment) || {},
        parseAurralIdentityComment(common.grouping) || {},
      );
      const expectedIdentity = [
        [
          common.musicbrainz_albumartistid ||
            common.musicbrainz_artistid ||
            embeddedIdentity.artistMbid,
          job.artistMbid,
        ],
        [
          common.musicbrainz_releasegroupid ||
            common.musicbrainz_albumid ||
            embeddedIdentity.albumMbid,
          job.albumMbid,
        ],
        [
          common.musicbrainz_recordingid ||
            common.musicbrainz_trackid ||
            embeddedIdentity.trackMbid,
          job.trackMbid,
        ],
      ].filter(([, value]) => String(value || "").trim());
      if (
        expected.every(
          ([actual, value]) => String(actual || "").trim() === String(value).trim(),
        ) &&
        expectedIdentity.every(
          ([actual, value]) => String(actual || "").trim() === String(value).trim(),
        )
      ) {
        continue;
      }
      await writeAudioMetadata(filePath, job);
      result.repaired += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
