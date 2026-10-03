import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { parseFile } from "music-metadata";
import {
  buildFallbackIdentityKey,
  buildIdentityKey,
  getLibraryMediaFile,
  getAvailableLibraryMediaPaths,
  linkLibraryAlbumTrack,
  markLibraryMediaFilesUnavailable,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
  withLibraryScan,
} from "./libraryMediaStore.js";
import { parseAurralIdentityComment } from "./playlistDownloadUtils.js";

const execFileAsync = promisify(execFile);

const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".aiff",
  ".ape",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
  ".wv",
]);

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "_fallback",
  "_flows",
  "_playlists",
  "_staging",
  "aurral-weekly-flow",
]);

export function isLibraryScanExcludedDirectory(name) {
  const value = String(name || "");
  return EXCLUDED_DIRECTORIES.has(value) || value.startsWith(".");
}

// Sidecar cover filenames recognised next to an audio file. Compared
// case-insensitively, exactly the set the repair sweep is allowed to write.
const SIDECAR_ART_FILENAMES = new Set([
  "cover.jpg",
  "cover.png",
  "folder.jpg",
  "front.jpg",
  "front.png",
  "front.jpeg",
]);

// Native tag ids that carry an attached picture, upper-cased for comparison:
// ID3v2 APIC, iTunes/MP4 covr, Vorbis METADATA_BLOCK_PICTURE, FLAC PICTURE.
const NATIVE_PICTURE_TAG_IDS = new Set([
  "APIC",
  "COVR",
  "COVERART",
  "PICTURE",
  "METADATA_BLOCK_PICTURE",
]);

const hasNativePictureTag = (metadata) => {
  for (const tags of Object.values(metadata?.native || {})) {
    if (!Array.isArray(tags)) continue;
    for (const tag of tags) {
      if (NATIVE_PICTURE_TAG_IDS.has(String(tag?.id || "").toUpperCase())) return true;
    }
  }
  return false;
};

/** True when a music-metadata result carries an attached picture. */
export function metadataHasPicture(metadata) {
  if (!metadata || typeof metadata !== "object") return false;
  const picture = metadata.common?.picture;
  if (Array.isArray(picture) ? picture.length > 0 : Boolean(picture)) return true;
  return hasNativePictureTag(metadata);
}

/**
 * Last-resort picture probe for containers music-metadata cannot parse.
 * Only reached when the tag parse itself throws, so the common path never
 * spawns a process.
 */
export async function probeEmbeddedArt(filePath) {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-select_streams",
        "v",
        "-show_entries",
        "stream=index",
        "-of",
        "csv=p=0",
        filePath,
      ],
      { timeout: 15000 },
    );
    return String(stdout || "").trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Reliable embedded-cover detection.
 *
 * The scan parses with `{ skipCovers: true }`, and music-metadata@11 strips
 * covr/APIC/METADATA_BLOCK_PICTURE from BOTH `common.picture` and `native.*`
 * under that flag (proved by .tests/library/metadata-repair.test.js). So the
 * scan's own metadata can never answer this question: re-parse with covers
 * kept and `duration: false`, which is the cheapest reliable signal available.
 *
 * `parse` is injectable and defaults to whatever reader the scan already uses,
 * so tests supplying a fake metadataReader never touch the filesystem twice.
 */
export async function detectEmbeddedArt(filePath, { metadata = null, parse = parseFile } = {}) {
  if (metadataHasPicture(metadata)) return true;
  try {
    return metadataHasPicture(await parse(filePath, { duration: false }));
  } catch {
    return probeEmbeddedArt(filePath);
  }
}

/**
 * True when the directory holds a recognised sidecar cover. Results are memoised
 * per directory via `cache` because every track in an album shares one lookup.
 */
export async function detectSidecarArt(dirPath, cache = null) {
  const directory = path.resolve(String(dirPath || ""));
  if (cache?.has(directory)) return cache.get(directory);
  let found = false;
  try {
    const entries = await fs.readdir(directory);
    found = entries.some((entry) => SIDECAR_ART_FILENAMES.has(String(entry).toLowerCase()));
  } catch {
    found = false;
  }
  cache?.set(directory, found);
  return found;
}

/** Cover-art presence flags for one audio file, computed during a scan. */
export async function detectArtFlags(filePath, { metadata = null, parse = parseFile, cache = null } = {}) {
  return {
    hasEmbeddedArt: await detectEmbeddedArt(filePath, { metadata, parse }),
    hasSidecarArt: await detectSidecarArt(path.dirname(filePath), cache),
  };
}

const text = (value) => String(value || "").trim();

const first = (value) => (Array.isArray(value) ? value[0] : value);

const numberPart = (value, fallback = 0) => {
  const number = Number(value?.no ?? value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback;
};

const normalizeMbid = (value) => text(first(value)) || null;

const normalizeMetadata = (metadata) => metadata?.common || {};

const parseNativeAurralIdentityComment = (metadata) => {
  for (const tags of Object.values(metadata?.native || {})) {
    if (!Array.isArray(tags)) continue;

    for (const tag of tags) {
      const id = String(tag?.id || "").toLowerCase();
      if (id !== "txxx:comment" && id !== "comm") continue;

      const embedded = parseAurralIdentityComment(tag?.value);
      if (embedded) return embedded;
    }
  }

  return null;
};

const applyMetadataEnrichment = (metadata, enrichment = null) => {
  const common = { ...normalizeMetadata(metadata) };
  const embedded = Object.assign(
    {},
    parseNativeAurralIdentityComment(metadata) || {},
    parseAurralIdentityComment(common.comment) || {},
    parseAurralIdentityComment(common.grouping) || {},
  );
  if (
    (!enrichment || typeof enrichment !== "object") &&
    Object.keys(embedded).length === 0
  ) {
    return metadata;
  }
  const trusted = { ...embedded, ...(enrichment || {}) };
  const fallbackFields = {
    albumartist: trusted.artistName,
    artist: trusted.artistName,
    album: trusted.albumName,
    title: trusted.trackName,
    date: trusted.releaseYear,
    track: trusted.trackNumber,
    musicbrainz_artistid: trusted.artistMbid,
    musicbrainz_albumartistid: trusted.artistMbid,
    musicbrainz_albumid: trusted.albumMbid,
    musicbrainz_releasegroupid: trusted.albumMbid,
    musicbrainz_recordingid: trusted.trackMbid,
    musicbrainz_trackid: trusted.trackMbid,
  };
  for (const [key, value] of Object.entries(fallbackFields)) {
    if (value == null || String(value).trim() === "") continue;
    if (common[key] == null || String(common[key]).trim() === "") common[key] = value;
  }
  return { ...(metadata || {}), common };
};

function readPathFallback(filePath, rootPath) {
  const relative = path.relative(rootPath, filePath);
  const segments = relative.split(path.sep).filter(Boolean);
  const fileName = path.basename(filePath, path.extname(filePath));
  return {
    artistName: text(segments.at(-3)) || "Unknown Artist",
    albumName: text(segments.at(-2)) || "Unknown Album",
    title: text(fileName.replace(/^\d+(?:[. _-]+|$)/, "")) || fileName,
    trackNumber: Number.parseInt(fileName.match(/^\d+/)?.[0] || "0", 10) || 0,
    discNumber: 1,
  };
}

function buildMetadataRecord(metadata, filePath, rootPath, artFlags = null) {
  const common = normalizeMetadata(metadata);
  const fallback = readPathFallback(filePath, rootPath);
  const artistName = text(common.albumartist || common.artist) || fallback.artistName;
  const albumName = text(common.album) || fallback.albumName;
  const title = text(common.title) || fallback.title;
  const trackNumber = numberPart(common.track, fallback.trackNumber);
  const discNumber = numberPart(common.disk, fallback.discNumber) || 1;
  const artistMbid = normalizeMbid(common.musicbrainz_albumartistid || common.musicbrainz_artistid);
  const albumMbid = normalizeMbid(common.musicbrainz_albumid);
  const releaseGroupMbid = normalizeMbid(common.musicbrainz_releasegroupid);
  const trackMbid = normalizeMbid(
    common.musicbrainz_recordingid || common.musicbrainz_trackid,
  );
  const artistKey =
    (artistMbid && buildIdentityKey("mbid", artistMbid)) ||
    buildFallbackIdentityKey("artist", artistName);
  const albumKey =
    (releaseGroupMbid && buildIdentityKey("release-group", releaseGroupMbid)) ||
    (albumMbid && buildIdentityKey("album", albumMbid)) ||
    buildFallbackIdentityKey("album", artistKey, albumName);
  const trackKey =
    (trackMbid && buildIdentityKey("recording", trackMbid)) ||
    buildFallbackIdentityKey("track", albumKey, discNumber, trackNumber, title);

  return {
    artistKey,
    artistMbid,
    artistName,
    albumKey,
    albumMbid,
    releaseGroupMbid,
    albumName,
    trackKey,
    trackMbid,
    title,
    trackNumber,
    discNumber,
    albumArtist: text(common.albumartist) || artistName,
    releaseDate: text(common.releasedate || common.date) || null,
    artistMetadata: { tags: common },
    albumMetadata: { tags: common },
    trackMetadata: { tags: common },
    durationMs: Number.isFinite(Number(metadata?.format?.duration))
      ? Math.round(Number(metadata.format.duration) * 1000)
      : null,
    hasEmbeddedArt: artFlags?.hasEmbeddedArt === true,
    hasSidecarArt: artFlags?.hasSidecarArt === true,
    quality: {
      format: text(metadata?.format?.codec) || null,
      bitrate: Number.isFinite(Number(metadata?.format?.bitrate))
        ? Math.round(Number(metadata.format.bitrate))
        : null,
      sampleRate: Number.isFinite(Number(metadata?.format?.sampleRate))
        ? Number(metadata.format.sampleRate)
        : null,
      bitsPerSample: Number.isFinite(Number(metadata?.format?.bitsPerSample))
        ? Number(metadata.format.bitsPerSample)
        : null,
    },
  };
}

async function* walkAudioFiles(rootPath) {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (isLibraryScanExcludedDirectory(entry.name)) continue;
      yield* walkAudioFiles(path.join(rootPath, entry.name));
      continue;
    }
    if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      yield path.join(rootPath, entry.name);
    }
  }
}

function isPathWithin(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const normalizePathKey = (value) => {
  const resolved = path.resolve(String(value || ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

export function createPathScopeMatcher(scopes = []) {
  const scopeKeys = new Set(
    (Array.isArray(scopes) ? scopes : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .map(normalizePathKey),
  );

  return (candidatePath) => {
    if (!String(candidatePath || "").trim() || scopeKeys.size === 0) return false;
    let currentPath = path.resolve(String(candidatePath));
    while (true) {
      if (scopeKeys.has(normalizePathKey(currentPath))) return true;
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) return false;
      currentPath = parentPath;
    }
  };
}

async function resolveChangedFiles(rootPath, changedPaths) {
  const filePaths = new Set();
  const reconcilePaths = new Set();

  for (const value of Array.isArray(changedPaths) ? changedPaths : []) {
    const rawPath = String(value || "").trim();
    if (!rawPath) continue;
    const changedPath = path.resolve(rawPath);
    if (!isPathWithin(rootPath, changedPath)) continue;

    let stat = null;
    let missing = false;
    try {
      stat = await fs.lstat(changedPath);
      if (stat.isSymbolicLink()) continue;
    } catch (error) {
      missing = error?.code === "ENOENT";
      if (!missing && !AUDIO_EXTENSIONS.has(path.extname(changedPath).toLowerCase())) {
        continue;
      }
    }

    if (stat?.isDirectory()) {
      reconcilePaths.add(changedPath);
      try {
        for await (const filePath of walkAudioFiles(changedPath)) filePaths.add(filePath);
      } catch (error) {
        if (error?.code !== "ENOENT") reconcilePaths.delete(changedPath);
      }
      continue;
    }

    if (stat?.isFile() || missing || AUDIO_EXTENSIONS.has(path.extname(changedPath).toLowerCase())) {
      filePaths.add(changedPath);
      reconcilePaths.add(changedPath);
      continue;
    }

    reconcilePaths.add(changedPath);
  }

  return {
    filePaths: [...filePaths],
    reconcilePaths: [...reconcilePaths],
  };
}

function normalizeScanPaths(rootPath, filePaths) {
  return [...new Set(
    (Array.isArray(filePaths) ? filePaths : [])
      .map((filePath) => path.resolve(String(filePath || "")))
      .filter((filePath) => isPathWithin(rootPath, filePath)),
  )];
}

export async function scanMusicRoot({
  rootPath,
  source = "aurral",
  filePaths = null,
  changedPaths = null,
  force = false,
  metadataReader = parseFile,
  metadataEnricher = null,
  syncSearch = true,
} = {}) {
  const resolvedRoot = path.resolve(String(rootPath || ""));
  await fs.mkdir(resolvedRoot, { recursive: true });
  const changed = Array.isArray(changedPaths)
    ? await resolveChangedFiles(resolvedRoot, changedPaths)
    : null;
  const requestedFiles = changed
    ? normalizeScanPaths(resolvedRoot, changed.filePaths).filter((filePath) =>
        AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase()),
      )
    : Array.isArray(filePaths)
      ? normalizeScanPaths(resolvedRoot, filePaths).filter((filePath) =>
          AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase()),
        )
      : null;
  const reconcilePaths = changed?.reconcilePaths || null;
  const result = { filesSeen: 0, filesIndexed: 0, filesFailed: 0 };
  const unseenPaths = requestedFiles ? null : getAvailableLibraryMediaPaths(source);
  const seenPaths = new Set();
  const failedPaths = new Set();
  const missingFilePaths = new Set();
  // One readdir per album directory instead of one per track.
  const sidecarArtCache = new Map();
  const scanResult = await withLibraryScan(source, resolvedRoot, (scanId) => {
    const run = async () => {
      const files = requestedFiles || walkAudioFiles(resolvedRoot);
      for await (const filePath of files) {
        result.filesSeen += 1;
        try {
          const stat = await fs.stat(filePath);
          const existing = getLibraryMediaFile({ source, path: filePath });
          if (
            force !== true &&
            existing?.available === 1 &&
            Number(existing.size) === stat.size &&
            Number(existing.mtime_ms) === stat.mtimeMs
          ) {
            unseenPaths?.delete(filePath);
            seenPaths.add(filePath);
            result.filesIndexed += 1;
            continue;
          }
          const metadata = await metadataReader(filePath, { skipCovers: true });
          const enrichedMetadata = applyMetadataEnrichment(
            metadata,
            typeof metadataEnricher === "function"
              ? await metadataEnricher(metadata, filePath)
              : null,
          );
          const record = buildMetadataRecord(
            enrichedMetadata,
            filePath,
            resolvedRoot,
            await detectArtFlags(filePath, {
              metadata,
              parse: metadataReader,
              cache: sidecarArtCache,
            }),
          );
          const artist = upsertLibraryArtist({
            identityKey: record.artistKey,
            mbid: record.artistMbid,
            name: record.artistName,
            metadata: record.artistMetadata,
            syncSearch,
          });
          const album = upsertLibraryAlbum({
            identityKey: record.albumKey,
            mbid: record.albumMbid,
            releaseGroupMbid: record.releaseGroupMbid,
            artistId: artist.id,
            title: record.albumName,
            albumArtist: record.albumArtist,
            releaseDate: record.releaseDate,
            metadata: record.albumMetadata,
            syncSearch,
          });
          const track = upsertLibraryTrack({
            identityKey: record.trackKey,
            mbid: record.trackMbid,
            title: record.title,
            artistName: record.artistName,
            metadata: record.trackMetadata,
            syncSearch,
          });
          linkLibraryAlbumTrack({
            albumId: album.id,
            trackId: track.id,
            discNumber: record.discNumber,
            trackNumber: record.trackNumber,
            syncSearch,
          });
          upsertLibraryMediaFile({
            trackId: track.id,
            albumId: album.id,
            source,
            path: filePath,
            format: path.extname(filePath).slice(1).toLowerCase(),
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            durationMs: record.durationMs,
            quality: record.quality,
            hasEmbeddedArt: record.hasEmbeddedArt,
            hasSidecarArt: record.hasSidecarArt,
            scanId,
          });
          unseenPaths?.delete(filePath);
          seenPaths.add(filePath);
          result.filesIndexed += 1;
        } catch (error) {
          result.filesFailed += 1;
          if (error?.code === "ENOENT") missingFilePaths.add(filePath);
          else failedPaths.add(filePath);
        }
      }
      if (unseenPaths && result.filesFailed === 0) {
        markLibraryMediaFilesUnavailable(source, unseenPaths);
      }
      if (requestedFiles) {
        const scopes = reconcilePaths || requestedFiles;
        const matchesReconcileScope = createPathScopeMatcher(scopes);
        const missingIndexedPaths = [...getAvailableLibraryMediaPaths(source)].filter((filePath) =>
          matchesReconcileScope(filePath) &&
          !seenPaths.has(filePath) &&
          !failedPaths.has(filePath),
        );
        const unavailablePaths = [
          ...missingFilePaths,
          ...missingIndexedPaths,
        ];
        if (unavailablePaths.length > 0) {
          markLibraryMediaFilesUnavailable(source, unavailablePaths);
        }
      }
      return result;
    };
    return run();
  });
  return scanResult;
}

export async function scanMusicRoots({ rootPaths = [], changedPaths = null, ...options } = {}) {
  const roots = [...new Set(
    (Array.isArray(rootPaths) ? rootPaths : [])
      .map((rootPath) => String(rootPath ?? "").trim())
      .filter(Boolean)
      .map((rootPath) => path.resolve(rootPath)),
  )];
  if (Array.isArray(changedPaths)) {
    const result = { filesSeen: 0, filesIndexed: 0, filesFailed: 0, changed: false };
    for (const rootPath of roots) {
      const paths = changedPaths.filter((changedPath) => isPathWithin(rootPath, changedPath));
      if (paths.length === 0) continue;
      try {
        const scan = await scanMusicRoot({ ...options, rootPath, changedPaths: paths });
        result.filesSeen += scan.filesSeen;
        result.filesIndexed += scan.filesIndexed;
        result.filesFailed += scan.filesFailed;
        result.changed ||= scan.changed;
      } catch {
        result.filesFailed += 1;
      }
    }
    return result;
  }
  const unseenPaths = getAvailableLibraryMediaPaths(options.source || "aurral");
  const result = { filesSeen: 0, filesIndexed: 0, filesFailed: 0, changed: false };
  const scannedRoots = [];

  for (const rootPath of roots) {
    let rootStat;
    try {
      rootStat = await fs.stat(rootPath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      result.filesFailed += 1;
      continue;
    }
    if (!rootStat.isDirectory()) {
      result.filesFailed += 1;
      continue;
    }

    try {
      const filePaths = [];
      for await (const filePath of walkAudioFiles(rootPath)) filePaths.push(filePath);
      const scan = await scanMusicRoot({ ...options, rootPath, filePaths });
      result.filesSeen += scan.filesSeen;
      result.filesIndexed += scan.filesIndexed;
      result.filesFailed += scan.filesFailed;
      result.changed ||= scan.changed;
      for (const filePath of filePaths) unseenPaths.delete(filePath);
      if (scan.filesFailed === 0) scannedRoots.push(rootPath);
    } catch {
      result.filesFailed += 1;
    }
  }

  if (scannedRoots.length > 0) {
    const missingPaths = [...unseenPaths].filter((filePath) =>
      scannedRoots.some((rootPath) => {
        const relative = path.relative(rootPath, filePath);
        return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
      }),
    );
    result.changed = markLibraryMediaFilesUnavailable(options.source || "aurral", missingPaths) > 0
      || result.changed;
  }

  return result;
}

export {
  buildMetadataRecord,
  readPathFallback,
  AUDIO_EXTENSIONS,
  SIDECAR_ART_FILENAMES,
};
