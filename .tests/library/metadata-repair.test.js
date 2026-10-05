import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseFile } from "music-metadata";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps },
  {
    getLibraryMediaFile,
    getLibraryMetadataGapCounts,
    linkLibraryAlbumTrack,
    selectLibraryMetadataGapRows,
    upsertLibraryAlbum,
    upsertLibraryArtist,
    upsertLibraryMediaFile,
    upsertLibraryTrack,
  },
  {
    detectEmbeddedArt,
    detectSidecarArt,
    metadataHasPicture,
    scanMusicRoot,
  },
  { repairMetadataGaps, resolveStrictAlbumMbid, writeMissingTags },
  { SCHEDULED_SYSTEM_TASKS, getSystemTaskQueueName },
  { processSystemTask },
  { registerMetadataGaps },
] = await setupIsolatedBackend(
  "metadata-repair",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/libraryFileScanner.js",
  "backend/services/metadataRepairService.js",
  "backend/services/honkerDb.js",
  "backend/services/systemTaskWorker.js",
  "backend/routes/library/handlers/metadataGaps.js",
);

const RELEASE_MBID = "11111111-2222-4333-8444-555555555555";
const RELEASE_GROUP_MBID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const RECORDING_MBID = "99999999-8888-4777-8666-555555555555";
const OTHER_RELEASE_MBID = "22222222-3333-4444-8555-666666666666";
const OTHER_RELEASE_GROUP_MBID = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const workDir = await mkdtemp(path.join(os.tmpdir(), "aurral-metadata-repair-"));
// ffmpeg intermediates live OUTSIDE every scan root: they end in .flac and would
// otherwise be walked as library tracks.
const buildDir = path.join(workDir, "build");
await fs.mkdir(buildDir, { recursive: true });

function runFfmpeg(args) {
  const result = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
}

const coverPngPath = path.join(buildDir, "cover-source.png");
runFfmpeg(["-f", "lavfi", "-i", "color=c=steelblue:s=32x32", "-frames:v", "1", coverPngPath]);
const COVER_BYTES = await fs.readFile(coverPngPath);

let rootSeq = 0;
let buildSeq = 0;

async function nextLibraryRoot() {
  const root = path.join(workDir, `library-${(rootSeq += 1)}`);
  await fs.mkdir(root, { recursive: true });
  return root;
}

// FLAC is the fixture format of record: it is the only container where ffmpeg's
// `-metadata musicbrainz_*` write round-trips back through music-metadata. For
// .m4a ffmpeg silently drops those keys, and for .mp3 it writes a TXXX frame
// whose description music-metadata does not map. Verified empirically; see the
// report for the production implication.
const CODEC_BY_FORMAT = { m4a: "aac", mp3: "mp3", flac: "flac" };

/** Builds an audio fixture in buildDir, then renames it into place. */
async function makeAudioFile(finalPath, { art = false, tags = {}, format = "flac" } = {}) {
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  const stem = `${path.basename(finalPath, path.extname(finalPath))}-${(buildSeq += 1)}`;
  let current = path.join(buildDir, `${stem}-base.${format}`);
  runFfmpeg([
    "-f", "lavfi", "-i", "anullsrc", "-t", "0.05",
    "-c:a", CODEC_BY_FORMAT[format] || "aac",
    current,
  ]);
  const entries = Object.entries(tags);
  if (entries.length > 0) {
    const tagged = path.join(buildDir, `${stem}-tagged.${format}`);
    runFfmpeg([
      "-i", current, "-map", "0", "-c", "copy",
      ...entries.flatMap(([key, value]) => ["-metadata", `${key}=${value}`]),
      tagged,
    ]);
    current = tagged;
  }
  if (art) {
    const withArt = path.join(buildDir, `${stem}-art.${format}`);
    runFfmpeg([
      "-i", current, "-i", coverPngPath,
      "-map", "0:a", "-map", "1:v", "-c:a", "copy", "-c:v", "copy",
      "-disposition:v", "attached_pic",
      withArt,
    ]);
    current = withArt;
  }
  await fs.rename(current, finalPath);
  return finalPath;
}

/** A file with embedded art AND a sidecar, so only an MBID gap can remain. */
async function makeArtCompleteFile(filePath, tags = {}) {
  await makeAudioFile(filePath, { art: true, tags });
  await fs.writeFile(path.join(path.dirname(filePath), "cover.jpg"), COVER_BYTES);
  return filePath;
}

/** A MusicBrainz /ws/2/recording?inc=releases release object. */
const fakeRelease = ({
  id = RELEASE_MBID,
  releaseGroupId = RELEASE_GROUP_MBID,
  title = "Animal Boy",
  releaseGroupTitle = "Animal Boy",
  primaryType = "Album",
  status = "Official",
  trackCount = 12,
} = {}) => ({
  id,
  title,
  status,
  "track-count": trackCount,
  "release-group": {
    id: releaseGroupId,
    title: releaseGroupTitle,
    "primary-type": primaryType,
  },
});

/** A MusicBrainz /ws/2/release-group search hit. */
const fakeReleaseGroup = ({
  id = RELEASE_GROUP_MBID,
  title = "Animal Boy",
  primaryType = "Album",
  artistName = "Ramones",
} = {}) => ({
  id,
  title,
  "primary-type": primaryType,
  "artist-credit": [{ name: artistName, joinphrase: "", artist: { id: "artist-1", name: artistName } }],
});

/** Scans one art-complete album dir whose file has no album MBID tags. */
async function seedMbidGapFile({
  album = "Animal Boy",
  artist = "Ramones",
  recordingMbid = RECORDING_MBID,
  trackOf = null,
} = {}) {
  const root = await nextLibraryRoot();
  const dir = path.join(root, artist, album);
  const filePath = path.join(dir, "01 Some Track.flac");
  const tags = { title: "Some Track", artist, album };
  // FLAC stores this as the MUSICBRAINZ_TRACKID vorbis comment, which
  // music-metadata maps back onto common.musicbrainz_recordingid.
  if (recordingMbid) tags.musicbrainz_trackid = recordingMbid;
  if (trackOf) tags.track = `1/${trackOf}`;
  await makeArtCompleteFile(filePath, tags);
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  if (trackOf) {
    const { common } = await parseFile(filePath, { skipCovers: true });
    assert.equal(common.track?.of, trackOf, "fixture must carry a total track count");
  }
  return { root, dir, filePath };
}

/** Seeds N gap rows cheaply: one real ffmpeg file, copied N times. */
async function seedGapRows({ count, keyPrefix, missingFirst = false }) {
  const root = await nextLibraryRoot();
  const dir = path.join(root, "Batch Artist", "Batch Album");
  await fs.mkdir(dir, { recursive: true });
  const template = path.join(buildDir, `${keyPrefix}-template.flac`);
  await makeAudioFile(template, {});
  const artist = upsertLibraryArtist({
    identityKey: `name:artist:${keyPrefix}`,
    name: "Batch Artist",
  });
  const album = upsertLibraryAlbum({
    identityKey: `name:album:${keyPrefix}`,
    artistId: artist.id,
    title: "Batch Album",
  });
  const paths = [];
  for (let index = 0; index < count; index += 1) {
    const name = `track-${String(index).padStart(4, "0")}${missingFirst && index === 0 ? "-missing" : ""}.flac`;
    const filePath = path.join(dir, name);
    // Row 0 is deliberately absent from disk when missingFirst is set.
    if (!(missingFirst && index === 0)) await fs.copyFile(template, filePath);
    const track = upsertLibraryTrack({
      identityKey: `name:track:${keyPrefix}:${index}`,
      title: `Track ${index}`,
      artistName: "Batch Artist",
    });
    linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, discNumber: 1, trackNumber: index });
    upsertLibraryMediaFile({
      trackId: track.id,
      albumId: album.id,
      source: "aurral",
      path: filePath,
      format: "flac",
      size: 1,
      mtimeMs: 1,
      scanId: 0,
    });
    paths.push(filePath);
  }
  return { root, dir, paths };
}

/** Full before/after fingerprint used to prove an operation did not mutate. */
async function snapshot(files, dirs) {
  const state = [];
  for (const filePath of files) {
    const stat = await fs.stat(filePath);
    const metadata = await parseFile(filePath);
    state.push({
      path: filePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      common: metadata.common,
      hasPicture: metadataHasPicture(metadata),
    });
  }
  for (const dir of dirs) {
    state.push({ dir, names: (await fs.readdir(dir)).sort() });
  }
  return state;
}

/**
 * Scalar native tags keyed by frame id, across every native container section
 * (ID3v2.x, vorbis). Picture blocks carry object values and are compared
 * byte-wise through common.picture instead.
 */
function nativeScalarTags(metadata) {
  const map = new Map();
  for (const tags of Object.values(metadata?.native || {})) {
    for (const { id, value } of tags || []) {
      if (value && typeof value === "object") continue;
      map.set(id, String(value));
    }
  }
  return map;
}

const gapsRoute = (() => {
  const routes = {};
  registerMetadataGaps({
    get(routePath, ...handlers) {
      routes[routePath] = handlers.at(-1);
    },
  });
  return routes["/metadata-gaps"];
})();

async function callGaps(query = {}) {
  let statusCode = 200;
  let body = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
    set() {
      return this;
    },
  };
  await gapsRoute({ query, user: { id: 1 } }, res);
  return { statusCode, body };
}

test.beforeEach(() => {
  resetDatabase(db);
  // resetDatabase deletes the settings rows but not the in-process cache.
  dbOps.invalidateSettingsCache();
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
  await fs.rm(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Scan flags + the picture-detection fixture proof
// ---------------------------------------------------------------------------

test("picture detection: skipCovers strips art while {duration:false} reveals it", async () => {
  const root = await nextLibraryRoot();
  for (const format of ["m4a", "mp3", "flac"]) {
    const withArt = await makeAudioFile(path.join(root, `art.${format}`), { art: true, format });
    const withoutArt = await makeAudioFile(path.join(root, `plain.${format}`), { format });

    // Negative control: the scan parses with skipCovers:true, and
    // music-metadata@11 strips covr / APIC / METADATA_BLOCK_PICTURE from BOTH
    // common.picture and native.* under that flag. That parse can never answer
    // the question, which is why detectEmbeddedArt re-parses.
    assert.equal(
      metadataHasPicture(await parseFile(withArt, { skipCovers: true })),
      false,
      `${format}: skipCovers must hide the picture`,
    );
    assert.equal(
      metadataHasPicture(await parseFile(withArt, { duration: false })),
      true,
      `${format}: {duration:false} must reveal the picture`,
    );
    assert.equal(
      metadataHasPicture(await parseFile(withoutArt, { duration: false })),
      false,
      `${format}: an artless file must not report a picture`,
    );
    assert.equal(await detectEmbeddedArt(withArt), true, format);
    assert.equal(await detectEmbeddedArt(withoutArt), false, format);
  }
});

test("scan stores has_embedded_art and has_sidecar_art", async () => {
  const root = await nextLibraryRoot();
  const dir = path.join(root, "Test Artist", "Test Album");
  const artFile = path.join(dir, "01 With Art.flac");
  const plainFile = path.join(dir, "02 Plain.flac");
  await makeAudioFile(artFile, {
    art: true,
    tags: { title: "With Art", artist: "Test Artist", album: "Test Album" },
  });
  await makeAudioFile(plainFile, {
    tags: { title: "Plain", artist: "Test Artist", album: "Test Album" },
  });

  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const artRow = getLibraryMediaFile({ source: "aurral", path: artFile });
  const plainRow = getLibraryMediaFile({ source: "aurral", path: plainFile });
  assert.equal(artRow.has_embedded_art, 1);
  assert.equal(artRow.has_sidecar_art, 0);
  assert.equal(plainRow.has_embedded_art, 0);
  assert.equal(plainRow.has_sidecar_art, 0);

  // A sidecar appearing later is invisible to an incremental scan because the
  // audio files are byte-identical (size + mtime unchanged) ...
  await fs.writeFile(path.join(dir, "cover.jpg"), COVER_BYTES);
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  assert.equal(
    getLibraryMediaFile({ source: "aurral", path: plainFile }).has_sidecar_art,
    0,
    "an unchanged file must not be re-parsed",
  );
  // ... and only a forced rescan picks it up.
  await scanMusicRoot({ rootPath: root, source: "aurral", force: true });
  assert.equal(getLibraryMediaFile({ source: "aurral", path: artFile }).has_sidecar_art, 1);
  assert.equal(getLibraryMediaFile({ source: "aurral", path: plainFile }).has_sidecar_art, 1);
  assert.equal(
    getLibraryMediaFile({ source: "aurral", path: plainFile }).has_embedded_art,
    0,
    "a sidecar must never imply embedded art",
  );
});

test("sidecar detection is case-insensitive, name-restricted and dir-cached", async () => {
  const root = await nextLibraryRoot();
  const upperDir = path.join(root, "Artist", "Upper");
  const otherDir = path.join(root, "Artist", "Other");
  const upperFile = path.join(upperDir, "01 Track.flac");
  const otherFile = path.join(otherDir, "01 Track.flac");
  await makeAudioFile(upperFile, {});
  await makeAudioFile(otherFile, {});
  await fs.writeFile(path.join(upperDir, "COVER.JPG"), COVER_BYTES);
  // A back cover is not a recognised front-cover sidecar.
  await fs.writeFile(path.join(otherDir, "back.jpg"), COVER_BYTES);

  await scanMusicRoot({ rootPath: root, source: "aurral" });
  assert.equal(getLibraryMediaFile({ source: "aurral", path: upperFile }).has_sidecar_art, 1);
  assert.equal(getLibraryMediaFile({ source: "aurral", path: otherFile }).has_sidecar_art, 0);

  const cache = new Map();
  assert.equal(await detectSidecarArt(upperDir, cache), true);
  assert.equal(cache.size, 1, "one readdir per directory, not one per track");
  await fs.rm(path.join(upperDir, "COVER.JPG"));
  assert.equal(await detectSidecarArt(upperDir, cache), true, "a warm cache is reused within a scan");
  assert.equal(await detectSidecarArt(upperDir, new Map()), false, "a cold cache re-reads the directory");
});

// ---------------------------------------------------------------------------
// 2. Album MBID fill - strict matching only
// ---------------------------------------------------------------------------

test("MBID fill: one strict Album candidate writes release + release-group MBIDs", async () => {
  const { filePath } = await seedMbidGapFile();
  assert.equal(getLibraryMetadataGapCounts().missingMbid, 1);
  assert.equal(getLibraryMetadataGapCounts().missingArt, 0, "art gaps must not pollute this case");

  const searches = [];
  const metrics = await repairMetadataGaps({
    resolveCover: async () => null,
    resolveAlbumMbid: (target) =>
      resolveStrictAlbumMbid(target, {
        getRecordingReleases: async () => [
          // Two exact-title Album candidates: Official must win over Promotion.
          fakeRelease({
            id: OTHER_RELEASE_MBID,
            releaseGroupId: OTHER_RELEASE_GROUP_MBID,
            status: "Promotion",
          }),
          fakeRelease(),
        ],
        searchReleaseGroup: async (...args) => {
          searches.push(args);
          return [];
        },
      }),
  });

  assert.equal(metrics.filesScanned, 1);
  assert.equal(metrics.mbidsFilled, 1);
  assert.equal(metrics.unresolved, 0);
  assert.equal(searches.length, 0, "a recording MBID must never fall through to search");

  const { common } = await parseFile(filePath, { skipCovers: true });
  assert.equal(common.musicbrainz_albumid, RELEASE_MBID);
  assert.equal(common.musicbrainz_releasegroupid, RELEASE_GROUP_MBID);
  assert.equal(common.musicbrainz_recordingid, RECORDING_MBID, "an existing tag must survive");
  // Done-marker: the row left the gap set with no re-parse.
  assert.deepEqual(getLibraryMetadataGapCounts(), { missingArt: 0, missingMbid: 0, total: 0 });
});

test("MBID fill: fuzzy, partial, wrong-type and ambiguous candidates are never written", async () => {
  const cases = [
    {
      name: "edition suffix on both titles",
      releases: [
        fakeRelease({ title: "Animal Boy (Deluxe Edition)", releaseGroupTitle: "Animal Boy (Deluxe)" }),
      ],
    },
    {
      name: "partial token overlap only",
      releases: [fakeRelease({ title: "Animal", releaseGroupTitle: "Animal" })],
    },
    {
      name: "non-Album primary type",
      releases: [fakeRelease({ primaryType: "Single" })],
    },
    {
      name: "track count disagrees",
      releases: [fakeRelease({ trackCount: 15 })],
      trackOf: 12,
    },
    {
      name: "two ambiguous candidates, neither Official",
      releases: [
        fakeRelease({ status: "Promotion" }),
        fakeRelease({
          id: OTHER_RELEASE_MBID,
          releaseGroupId: OTHER_RELEASE_GROUP_MBID,
          status: "Promotion",
        }),
      ],
    },
  ];

  for (const testCase of cases) {
    resetDatabase(db);
    dbOps.invalidateSettingsCache();
    const { filePath } = await seedMbidGapFile({ trackOf: testCase.trackOf });
    const before = await snapshot([filePath], [path.dirname(filePath)]);

    const metrics = await repairMetadataGaps({
      resolveCover: async () => null,
      resolveAlbumMbid: (target) =>
        resolveStrictAlbumMbid(target, {
          getRecordingReleases: async () => testCase.releases,
          searchReleaseGroup: async () => [],
        }),
    });

    assert.equal(metrics.mbidsFilled, 0, testCase.name);
    assert.equal(metrics.unresolved, 1, testCase.name);
    const { common } = await parseFile(filePath, { skipCovers: true });
    assert.equal(common.musicbrainz_albumid, undefined, `${testCase.name}: nothing may be written`);
    assert.equal(common.musicbrainz_releasegroupid, undefined, testCase.name);
    assert.deepEqual(
      await snapshot([filePath], [path.dirname(filePath)]),
      before,
      `${testCase.name}: the file must be untouched`,
    );
    assert.equal(getLibraryMetadataGapCounts().missingMbid, 1, `${testCase.name}: still a gap`);
  }
});

test("MBID fill: normalization accepts case, whitespace and diacritic variants", async () => {
  // The file's album tag differs only by case, doubled whitespace and an
  // accent - all collapsed by normalizeNameForMatch, still an exact match.
  const { filePath } = await seedMbidGapFile({ album: "Ánimal  Boy" });
  const metrics = await repairMetadataGaps({
    resolveCover: async () => null,
    resolveAlbumMbid: (target) =>
      resolveStrictAlbumMbid(target, {
        getRecordingReleases: async () => [
          fakeRelease({ title: "animal boy", releaseGroupTitle: "ANIMAL BOY" }),
        ],
        searchReleaseGroup: async () => [],
      }),
  });
  assert.equal(metrics.mbidsFilled, 1);
  const { common } = await parseFile(filePath, { skipCovers: true });
  assert.equal(common.musicbrainz_albumid, RELEASE_MBID);
});

test("MBID fill: without a recording MBID only an exact artist+album group match is accepted", async () => {
  const { filePath } = await seedMbidGapFile({ recordingMbid: null });
  const metrics = await repairMetadataGaps({
    resolveCover: async () => null,
    resolveAlbumMbid: (target) =>
      resolveStrictAlbumMbid(target, {
        getRecordingReleases: async () => {
          throw new Error("no recording MBID means no recording lookup");
        },
        searchReleaseGroup: async () => [fakeReleaseGroup()],
      }),
  });
  assert.equal(metrics.mbidsFilled, 1);
  const { common } = await parseFile(filePath, { skipCovers: true });
  assert.equal(common.musicbrainz_releasegroupid, RELEASE_GROUP_MBID);
  assert.equal(
    common.musicbrainz_albumid,
    undefined,
    "a release-group hit must never be written into the release MBID tag",
  );

  // ACCEPTED LIMITATION (issue #14): a release-group-only resolution leaves
  // library_albums.mbid NULL, so the row stays in the gap set and is revisited
  // on the next run. Bounded by the tag-reconcile fast path (no network once
  // the tag exists) and by repairBatchLimit.
  assert.equal(getLibraryMetadataGapCounts().missingMbid, 1);
  const rerun = await repairMetadataGaps({
    resolveCover: async () => null,
    resolveAlbumMbid: async () => {
      throw new Error("a filled release-group tag must short-circuit before any lookup");
    },
  });
  assert.equal(rerun.mbidsFilled, 0);
  assert.equal(rerun.filesScanned, 1);
});

test("MBID fill: a near-miss artist in release-group search is rejected", async () => {
  for (const group of [
    fakeReleaseGroup({ artistName: "The Ramones" }),
    fakeReleaseGroup({ title: "Animal Boy (Remastered)" }),
    fakeReleaseGroup({ primaryType: "EP" }),
  ]) {
    resetDatabase(db);
    dbOps.invalidateSettingsCache();
    const seeded = await seedMbidGapFile({ recordingMbid: null });
    const metrics = await repairMetadataGaps({
      resolveCover: async () => null,
      resolveAlbumMbid: (target) =>
        resolveStrictAlbumMbid(target, {
          getRecordingReleases: async () => [],
          searchReleaseGroup: async () => [group],
        }),
    });
    assert.equal(metrics.mbidsFilled, 0, JSON.stringify(group));
    assert.equal(metrics.unresolved, 1, JSON.stringify(group));
    const { common } = await parseFile(seeded.filePath, { skipCovers: true });
    assert.equal(common.musicbrainz_releasegroupid, undefined);
  }
});

test("MBID fill: an existing album MBID is never rewritten, even with a stale store row", async () => {
  const root = await nextLibraryRoot();
  const dir = path.join(root, "Ramones", "Animal Boy");
  const filePath = path.join(dir, "01 Some Track.flac");
  await makeArtCompleteFile(filePath, {
    title: "Some Track",
    artist: "Ramones",
    album: "Animal Boy",
    musicbrainz_albumid: RELEASE_MBID,
    musicbrainz_releasegroupid: RELEASE_GROUP_MBID,
  });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  assert.equal(getLibraryMetadataGapCounts().missingMbid, 0, "the scanner reads the tags into the store");

  // Force the stale-store case: the row re-enters the gap set while the file
  // already carries a complete identity.
  db.prepare("UPDATE library_albums SET mbid = NULL, release_group_mbid = NULL").run();
  assert.equal(getLibraryMetadataGapCounts().missingMbid, 1);

  const before = await snapshot([filePath], [dir]);
  let resolverCalls = 0;
  const metrics = await repairMetadataGaps({
    resolveCover: async () => null,
    resolveAlbumMbid: async () => {
      resolverCalls += 1;
      return { albumMbid: OTHER_RELEASE_MBID, releaseGroupMbid: OTHER_RELEASE_GROUP_MBID, via: "test" };
    },
  });

  assert.equal(resolverCalls, 0, "a complete file identity must short-circuit before any lookup");
  assert.equal(metrics.mbidsFilled, 0);
  assert.deepEqual(await snapshot([filePath], [dir]), before, "the file must not be rewritten");
  // The store is reconciled FROM the tags, so the row leaves the gap set.
  assert.equal(getLibraryMetadataGapCounts().missingMbid, 0);
  const album = db.prepare("SELECT mbid, release_group_mbid FROM library_albums").get();
  assert.equal(album.mbid, RELEASE_MBID);
  assert.equal(album.release_group_mbid, RELEASE_GROUP_MBID);
});

// ---------------------------------------------------------------------------
// 2b. Gap predicate - orphan media rows
// ---------------------------------------------------------------------------

test("gap predicate: orphan media rows (NULL album_id) are never selected", async () => {
  // A normal gap row so the selection set is non-empty and the orphan's
  // exclusion is provable against a row that IS returned.
  const { filePath: normalPath } = await seedMbidGapFile();

  // Register an orphan WITHOUT an album link: album_id stays NULL, so the
  // LEFT JOIN yields album.mbid IS NULL. Before the fix this row matched the
  // predicate forever - fillLibraryAlbumMbids keys off album.id and can never
  // fill a NULL album_id - starving the fixed per-run batch budget.
  const root = await nextLibraryRoot();
  const orphanPath = path.join(root, "01 Orphan.flac");
  await makeAudioFile(orphanPath, {
    tags: { title: "Orphan", artist: "Orphan Artist", album: "Orphan Album" },
  });
  const track = upsertLibraryTrack({
    identityKey: "name:track:orphan",
    title: "Orphan",
    artistName: "Orphan Artist",
  });
  upsertLibraryMediaFile({
    trackId: track.id,
    albumId: null,
    source: "aurral",
    path: orphanPath,
    format: "flac",
    size: 1,
    mtimeMs: 1,
    scanId: 0,
  });
  assert.equal(
    getLibraryMediaFile({ source: "aurral", path: orphanPath }).album_id,
    null,
    "fixture must really carry a NULL album_id",
  );

  assert.equal(
    getLibraryMetadataGapCounts().total,
    1,
    "the orphan row must not join the gap counts (only the normal row does)",
  );
  assert.deepEqual(
    selectLibraryMetadataGapRows({ limit: 10 }).map((row) => row.path),
    [normalPath],
    "the orphan row must never be selected",
  );

  const metrics = await repairMetadataGaps({
    resolveCover: async () => null,
    resolveAlbumMbid: async () => null,
  });
  assert.equal(metrics.filesScanned, 1, "the sweep must never visit the orphan row");

  const { body } = await callGaps({ limit: "10", offset: "0" });
  assert.deepEqual(
    body.items.map((item) => item.path),
    [normalPath],
    "the gaps endpoint must not list the orphan row",
  );
});

// ---------------------------------------------------------------------------
// 3. Cover-art fill
// ---------------------------------------------------------------------------

test("art fill: missing art is embedded and both sidecars are written", async () => {
  const root = await nextLibraryRoot();
  const dir = path.join(root, "Artist", "Album");
  const filePath = path.join(dir, "01 Track.flac");
  await makeAudioFile(filePath, {
    tags: {
      title: "Track",
      artist: "Artist",
      album: "Album",
      musicbrainz_albumid: RELEASE_MBID,
      musicbrainz_releasegroupid: RELEASE_GROUP_MBID,
    },
  });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  assert.equal(getLibraryMetadataGapCounts().missingArt, 1);

  let resolverCalls = 0;
  const metrics = await repairMetadataGaps({
    resolveCover: async (target) => {
      resolverCalls += 1;
      assert.equal(target.albumName, "Album");
      assert.equal(target.artistName, "Artist");
      assert.equal(target.path, filePath);
      return { bytes: COVER_BYTES, mimeType: "image/png" };
    },
    resolveAlbumMbid: async () => null,
  });

  assert.equal(resolverCalls, 1);
  assert.equal(metrics.artEmbedded, 1);
  assert.equal(metrics.sidecarsWritten, 2);
  assert.equal(metrics.mbidsFilled, 0);
  assert.equal(await detectEmbeddedArt(filePath), true);
  assert.deepEqual(await fs.readFile(path.join(dir, "cover.jpg")), COVER_BYTES);
  assert.deepEqual(await fs.readFile(path.join(dir, "folder.jpg")), COVER_BYTES);
  const row = getLibraryMediaFile({ source: "aurral", path: filePath });
  assert.equal(row.has_embedded_art, 1);
  assert.equal(row.has_sidecar_art, 1);
  assert.deepEqual(getLibraryMetadataGapCounts(), { missingArt: 0, missingMbid: 0, total: 0 });
});

test("art fill: an existing sidecar is never overwritten (wx)", async () => {
  const root = await nextLibraryRoot();
  const dir = path.join(root, "Artist", "Album");
  const filePath = path.join(dir, "01 Track.flac");
  await makeAudioFile(filePath, {
    tags: {
      title: "Track",
      artist: "Artist",
      album: "Album",
      musicbrainz_albumid: RELEASE_MBID,
      musicbrainz_releasegroupid: RELEASE_GROUP_MBID,
    },
  });
  await scanMusicRoot({ rootPath: root, source: "aurral" });

  // A sidecar lands after the scan, so the store still reports the gap.
  const sentinel = Buffer.from("pre-existing sidecar, do not replace");
  await fs.writeFile(path.join(dir, "cover.jpg"), sentinel);

  const metrics = await repairMetadataGaps({
    // No mimeType: the resolver contract must tolerate a bare byte payload.
    resolveCover: async () => ({ bytes: COVER_BYTES }),
    resolveAlbumMbid: async () => null,
  });

  assert.deepEqual(
    await fs.readFile(path.join(dir, "cover.jpg")),
    sentinel,
    "wx must refuse to replace an existing sidecar",
  );
  assert.deepEqual(await fs.readFile(path.join(dir, "folder.jpg")), COVER_BYTES);
  assert.equal(metrics.sidecarsWritten, 1, "only the missing sidecar is written");
  assert.equal(metrics.artEmbedded, 1);
  assert.equal(getLibraryMediaFile({ source: "aurral", path: filePath }).has_sidecar_art, 1);
});

test("art fill: embedCoverArt and sidecarCoverArt switches are honoured", async () => {
  const root = await nextLibraryRoot();
  const dir = path.join(root, "Artist", "Album");
  const filePath = path.join(dir, "01 Track.flac");
  await makeAudioFile(filePath, {
    tags: {
      title: "Track",
      artist: "Artist",
      album: "Album",
      musicbrainz_albumid: RELEASE_MBID,
      musicbrainz_releasegroupid: RELEASE_GROUP_MBID,
    },
  });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  dbOps.updateSettings({ enrichment: { embedCoverArt: false, sidecarCoverArt: false } });

  const before = await snapshot([filePath], [dir]);
  let resolverCalls = 0;
  const metrics = await repairMetadataGaps({
    resolveCover: async () => {
      resolverCalls += 1;
      return { bytes: COVER_BYTES };
    },
    resolveAlbumMbid: async () => null,
  });

  assert.equal(resolverCalls, 0, "a disabled art fill must not even resolve bytes");
  assert.equal(metrics.artEmbedded, 0);
  assert.equal(metrics.sidecarsWritten, 0);
  assert.equal(metrics.skipped, 1);
  assert.equal(metrics.unresolved, 0);
  assert.deepEqual(await snapshot([filePath], [dir]), before);
  assert.equal(getLibraryMediaFile({ source: "aurral", path: filePath }).has_embedded_art, 0);
});

// ---------------------------------------------------------------------------
// 4. Merge-only tag writes
// ---------------------------------------------------------------------------

test("merge-only: existing tags and embedded art survive a repair write", async () => {
  const root = await nextLibraryRoot();
  const dir = path.join(root, "Ramones", "Animal Boy");
  const filePath = path.join(dir, "01 Some Track.flac");
  await makeArtCompleteFile(filePath, {
    title: "Bonzo Goes to Bitburg",
    artist: "Ramones",
    album_artist: "The Ramones",
    album: "Animal Boy",
    date: "1986",
    track: "5/12",
    musicbrainz_trackid: RECORDING_MBID,
  });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const before = (await parseFile(filePath)).common;
  assert.equal(before.title, "Bonzo Goes to Bitburg");
  assert.equal(before.albumartist, "The Ramones", "fixture must carry a distinct album artist");

  const metrics = await repairMetadataGaps({
    resolveCover: async () => null,
    resolveAlbumMbid: (target) =>
      resolveStrictAlbumMbid(target, {
        getRecordingReleases: async () => [fakeRelease()],
        searchReleaseGroup: async () => [],
      }),
  });
  assert.equal(metrics.mbidsFilled, 1);

  const after = (await parseFile(filePath)).common;
  for (const key of ["title", "artist", "albumartist", "album", "year", "track"]) {
    assert.deepEqual(after[key], before[key], `${key} must survive byte-identically`);
  }
  assert.equal(after.musicbrainz_recordingid, RECORDING_MBID, "an existing MBID must survive");
  assert.equal(after.musicbrainz_albumid, RELEASE_MBID, "only the missing field is added");
  assert.equal(after.musicbrainz_releasegroupid, RELEASE_GROUP_MBID);
  assert.equal(
    metadataHasPicture(await parseFile(filePath, { duration: false })),
    true,
    "a tag write must not drop the embedded picture",
  );
});

// ---------------------------------------------------------------------------
// 4b. Tag preservation across the ffmpeg rewrite (data-loss proof)
// ---------------------------------------------------------------------------

test("tag preservation: custom tags and embedded pictures survive a writeTagsAtomic rewrite", async () => {
  for (const format of ["mp3", "flac"]) {
    const root = await nextLibraryRoot();
    const filePath = path.join(root, `legacy.${format}`);
    // Legacy-library fixture: non-whitelisted custom tags (genre/comment/
    // lyrics-style) plus an embedded picture - exactly what a repair rewrite
    // of an old file must not destroy.
    await makeAudioFile(filePath, {
      format,
      art: true,
      tags: {
        title: "Legacy Title",
        genre: "Punk",
        comment: "legacy rip comment",
        lyrics: "legacy lyrics line",
      },
    });
    const before = await parseFile(filePath, { skipCovers: false });
    assert.deepEqual(before.common.genre, ["Punk"], `${format}: fixture must carry the custom genre`);
    assert.equal(before.common.picture?.length, 1, `${format}: fixture must carry an embedded picture`);
    const beforeTags = nativeScalarTags(before);
    assert.ok(beforeTags.size >= 4, `${format}: fixture must carry the custom tags`);

    const result = await writeMissingTags(filePath, { musicbrainz_albumid: RELEASE_MBID });
    assert.equal(result.written, true, format);
    assert.deepEqual(result.applied, { musicbrainz_albumid: RELEASE_MBID }, format);

    const after = await parseFile(filePath, { skipCovers: false });
    // Every scalar native tag present before the rewrite survives with its
    // exact value (mp3: TCON / TXXX:comment / TXXX:USLT; flac: GENRE /
    // DESCRIPTION / LYRICS).
    const afterTags = nativeScalarTags(after);
    for (const [id, value] of beforeTags) {
      assert.equal(afterTags.get(id), value, `${format}: native tag ${id} must survive the rewrite`);
    }
    assert.deepEqual(after.common.genre, ["Punk"], `${format}: genre must survive`);
    assert.equal(after.common.picture?.length, 1, `${format}: the embedded picture must survive`);
    assert.deepEqual(
      Buffer.from(after.common.picture[0].data),
      Buffer.from(before.common.picture[0].data),
      `${format}: picture bytes must be identical`,
    );
    // Proof the rewrite really happened: flac maps the new key onto common;
    // mp3 keeps it as a TXXX frame whose lowercase description
    // music-metadata does not map (documented ffmpeg/mp3 quirk), so it is
    // asserted at the native level instead.
    if (format === "flac") {
      assert.equal(after.common.musicbrainz_albumid, RELEASE_MBID, format);
    } else {
      assert.equal(afterTags.get("TXXX:musicbrainz_albumid"), RELEASE_MBID, format);
    }
  }
});

// ---------------------------------------------------------------------------
// 4c. FILLABLE_TAGS identity-conflation regression
// ---------------------------------------------------------------------------

test("FILLABLE_TAGS: an AURRAL_IDS identity never masks a missing release-group tag", async () => {
  const root = await nextLibraryRoot();
  const dir = path.join(root, "Ramones", "Animal Boy");
  const filePath = path.join(dir, "01 Some Track.flac");
  // The identity's albumMbid is release-GROUP level, but it is the job's
  // identity - not proof that the musicbrainz_releasegroupid TAG exists. The
  // pre-fix reader fell back to identity.albumMbid, reported the tag as
  // filled, and the row became a permanent gap: the sweep never wrote the tag
  // and the store reconcile (which reads tags, not identity) never filled it.
  const identity = `AURRAL_IDS=${JSON.stringify({
    artistMbid: "11111111-1111-4111-8111-111111111111",
    albumMbid: RELEASE_GROUP_MBID,
  })}`;
  await makeArtCompleteFile(filePath, {
    title: "Some Track",
    artist: "Ramones",
    album: "Animal Boy",
    musicbrainz_albumid: RELEASE_MBID,
    grouping: identity,
  });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  // The scanner applies its own identity fallback when it populates the store,
  // so force the stale-store case: release_group_mbid is NULL while the FILE
  // carries only the identity - exactly the state where the pre-fix
  // FILLABLE_TAGS reader conflated identity.albumMbid with the missing tag.
  db.prepare("UPDATE library_albums SET release_group_mbid = NULL").run();
  assert.equal(
    getLibraryMetadataGapCounts().missingMbid,
    1,
    "release_group_mbid is NULL in the store while the file lacks the tag",
  );

  const metrics = await repairMetadataGaps({
    resolveCover: async () => null,
    resolveAlbumMbid: async () => ({
      albumMbid: RELEASE_MBID,
      releaseGroupMbid: RELEASE_GROUP_MBID,
      via: "test",
    }),
  });

  assert.equal(
    metrics.mbidsFilled,
    1,
    "the missing release-group tag must be written, not masked by the identity",
  );
  const { common } = await parseFile(filePath, { skipCovers: true });
  assert.equal(common.musicbrainz_releasegroupid, RELEASE_GROUP_MBID);
  assert.equal(common.musicbrainz_albumid, RELEASE_MBID, "the existing tag must be untouched");
  assert.equal(common.grouping, identity, "the identity comment must survive the rewrite");
  assert.deepEqual(getLibraryMetadataGapCounts(), { missingArt: 0, missingMbid: 0, total: 0 });
});

// ---------------------------------------------------------------------------
// 4d. Empty-output guard (data-loss protection)
// ---------------------------------------------------------------------------

test("empty-output guard: a zero-byte or missing ffmpeg output never replaces the original", async () => {
  const root = await nextLibraryRoot();
  const filePath = path.join(root, "guarded.flac");
  await makeAudioFile(filePath, {
    tags: { title: "Guarded", artist: "Guard Artist", album: "Guard Album" },
  });
  const before = await snapshot([filePath], [root]);

  // PATH shims that exit 0 like a successful ffmpeg but produce (a) a
  // zero-byte output file or (b) no output file at all - exactly the two
  // states the guard between execFileAsync and fs.rename exists for.
  const shimRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-ffmpeg-shim-"));
  const shims = {
    "zero-byte": '#!/bin/sh\nfor last in "$@"; do :; done\n: > "$last"\nexit 0\n',
    missing: "#!/bin/sh\nexit 0\n",
  };
  const originalPath = process.env.PATH;
  try {
    for (const [name, script] of Object.entries(shims)) {
      const shimDir = path.join(shimRoot, name);
      await fs.mkdir(shimDir, { recursive: true });
      await fs.writeFile(path.join(shimDir, "ffmpeg"), script, { mode: 0o755 });
      process.env.PATH = `${shimDir}${path.delimiter}${originalPath}`;
      await assert.rejects(
        writeMissingTags(filePath, { musicbrainz_albumid: RELEASE_MBID }),
        /ffmpeg produced empty output/,
        `${name}: the guard must refuse to rename a non-viable output`,
      );
    }
  } finally {
    process.env.PATH = originalPath;
    await fs.rm(shimRoot, { recursive: true, force: true });
  }

  assert.deepEqual(
    await snapshot([filePath], [root]),
    before,
    "the original must be byte-identical and no temp file may leak",
  );
  const { common } = await parseFile(filePath, { skipCovers: true });
  assert.equal(common.musicbrainz_albumid, undefined, "nothing may have been written");
});

// ---------------------------------------------------------------------------
// 5. Batch limit
// ---------------------------------------------------------------------------

test("batch limit: 201 gap rows process 200 and report 1 deferred", async () => {
  dbOps.updateSettings({ enrichment: { repairFillMbid: false } });
  await seedGapRows({ count: 201, keyPrefix: "batch" });
  assert.equal(getLibraryMetadataGapCounts().total, 201);

  const metrics = await repairMetadataGaps({ resolveCover: async () => null });
  assert.equal(metrics.filesScanned, 200);
  assert.equal(metrics.unresolved, 200);
  assert.equal(metrics.skipped, 1, "the 201st row is deferred to the next run");
  assert.equal(metrics.errors.length, 0);
  assert.equal(getLibraryMetadataGapCounts().total, 201, "a deferred row stays in the gap set");

  // The settings-driven batch limit is honoured on the next run.
  dbOps.updateSettings({ enrichment: { repairFillMbid: false, repairBatchLimit: 3 } });
  const limited = await repairMetadataGaps({ resolveCover: async () => null });
  assert.equal(limited.filesScanned, 3);
  assert.equal(limited.skipped, 198);

  // An explicit `limit` argument overrides the configured batch limit.
  const overridden = await repairMetadataGaps({ limit: 5, resolveCover: async () => null });
  assert.equal(overridden.filesScanned, 5);
  assert.equal(overridden.skipped, 196);
});

// ---------------------------------------------------------------------------
// 6. Kill switch
// ---------------------------------------------------------------------------

test("kill switch: repairSweepEnabled false returns zeroed metrics and writes nothing", async () => {
  const root = await nextLibraryRoot();
  const dir = path.join(root, "Artist", "Album");
  const filePath = path.join(dir, "01 Track.flac");
  await makeAudioFile(filePath, { tags: { title: "Track", artist: "Artist", album: "Album" } });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  assert.ok(getLibraryMetadataGapCounts().total > 0, "fixture must have gaps to repair");

  dbOps.updateSettings({ enrichment: { repairSweepEnabled: false } });
  const before = await snapshot([filePath], [dir]);
  let resolverCalls = 0;
  const metrics = await repairMetadataGaps({
    resolveCover: async () => {
      resolverCalls += 1;
      return { bytes: COVER_BYTES };
    },
    resolveAlbumMbid: async () => {
      resolverCalls += 1;
      return { albumMbid: RELEASE_MBID, releaseGroupMbid: RELEASE_GROUP_MBID };
    },
  });

  assert.deepEqual(metrics, {
    filesScanned: 0,
    mbidsFilled: 0,
    artEmbedded: 0,
    sidecarsWritten: 0,
    skipped: 0,
    unresolved: 0,
    errors: [],
  });
  assert.equal(resolverCalls, 0, "the kill switch must short-circuit before any resolver");
  assert.deepEqual(await snapshot([filePath], [dir]), before);
  const row = getLibraryMediaFile({ source: "aurral", path: filePath });
  assert.equal(row.has_embedded_art, 0);
  assert.equal(row.has_sidecar_art, 0);
});

// ---------------------------------------------------------------------------
// Yield / continue semantics and per-file error isolation
// ---------------------------------------------------------------------------

test("yield: 30 rows with a missing first path visit every other row exactly once", async () => {
  dbOps.updateSettings({ enrichment: { repairFillMbid: false } });
  const { paths } = await seedGapRows({ count: 30, keyPrefix: "yield", missingFirst: true });
  assert.equal(getLibraryMetadataGapCounts().total, 30);

  const seen = [];
  const metrics = await repairMetadataGaps({
    resolveCover: async (target) => {
      seen.push(target.path);
      return null;
    },
  });

  assert.equal(metrics.filesScanned, 30);
  assert.equal(metrics.skipped, 1, "the missing file is skipped; nothing is deferred");
  assert.equal(metrics.unresolved, 29);
  assert.equal(metrics.errors.length, 0);
  // `continue` inside try/finally must neither skip nor double-process a row
  // across the 25-file setImmediate yield boundary.
  assert.deepEqual(seen, paths.slice(1), "every existing row is visited once, in rowid order");
  assert.equal(new Set(seen).size, seen.length, "no row is processed twice");
});

test("errors: a per-file failure is recorded and the sweep continues", async () => {
  dbOps.updateSettings({ enrichment: { repairFillMbid: false } });
  const { paths } = await seedGapRows({ count: 2, keyPrefix: "errors" });
  // Replace the first file's bytes with garbage so parseFile rejects it
  // ("Invalid FLAC preamble"), which must land in metrics.errors.
  await fs.writeFile(paths[0], Buffer.from("this is not an audio file"));

  const seen = [];
  const metrics = await repairMetadataGaps({
    resolveCover: async (target) => {
      seen.push(target.path);
      return null;
    },
  });

  assert.equal(metrics.filesScanned, 2);
  assert.equal(metrics.errors.length, 1);
  assert.equal(metrics.errors[0].path, paths[0]);
  assert.ok(metrics.errors[0].message.length > 0);
  assert.deepEqual(seen, [paths[1]], "the healthy row is still processed after the failure");
  assert.equal(metrics.unresolved, 1);
});

// ---------------------------------------------------------------------------
// 8. Scheduling registration and dispatch
// ---------------------------------------------------------------------------

test("registration: the sweep is scheduled on the maintenance queue and dispatches", async () => {
  const task = SCHEDULED_SYSTEM_TASKS.find((entry) => entry.name === "metadata-repair-sweep");
  assert.ok(task, "metadata-repair-sweep must be registered");
  assert.equal(task.queue, "system-task-maintenance");
  assert.equal(task.schedule, "@every 6h");
  assert.deepEqual(task.payload, { kind: "metadata-repair-sweep" });
  // The scheduler queue and the enqueue router must agree, otherwise this task
  // would add a second mismatch to honker-db-config's queue-consistency check.
  assert.equal(getSystemTaskQueueName("metadata-repair-sweep"), task.queue);

  const metrics = await processSystemTask({ kind: "metadata-repair-sweep" });
  assert.deepEqual(metrics, {
    filesScanned: 0,
    mbidsFilled: 0,
    artEmbedded: 0,
    sidecarsWritten: 0,
    skipped: 0,
    unresolved: 0,
    errors: [],
  });
});

// ---------------------------------------------------------------------------
// 9. Gaps endpoint - read-only
// ---------------------------------------------------------------------------

test("gaps endpoint: reports counts and items without mutating anything", async () => {
  const root = await nextLibraryRoot();
  const gapDir = path.join(root, "Artist", "Gap Album");
  const okDir = path.join(root, "Artist", "Complete Album");
  const gapFile = path.join(gapDir, "01 Track.flac");
  await makeAudioFile(gapFile, { tags: { title: "Gap", artist: "Artist", album: "Gap Album" } });
  const okFile = await makeArtCompleteFile(path.join(okDir, "01 Track.flac"), {
    title: "Complete",
    artist: "Artist",
    album: "Complete Album",
    musicbrainz_albumid: RELEASE_MBID,
    musicbrainz_releasegroupid: RELEASE_GROUP_MBID,
  });
  await scanMusicRoot({ rootPath: root, source: "aurral" });

  const before = await snapshot([gapFile, okFile], [gapDir, okDir]);
  const { statusCode, body } = await callGaps({ limit: "10", offset: "0" });

  assert.equal(statusCode, 200);
  assert.deepEqual(body.counts, { missingArt: 1, missingMbid: 1, total: 1 });
  assert.deepEqual(body.items, [{ path: gapFile, missing: ["art", "albumMbid"] }]);
  assert.equal(body.limit, 10);
  assert.equal(body.offset, 0);
  assert.deepEqual(
    await snapshot([gapFile, okFile], [gapDir, okDir]),
    before,
    "the endpoint must be strictly read-only: no mtime, tag or directory change",
  );
});

test("gaps endpoint: pages with limit/offset and clamps bad input", async () => {
  dbOps.updateSettings({ enrichment: { repairFillMbid: false } });
  const { paths } = await seedGapRows({ count: 3, keyPrefix: "paging" });

  const page1 = await callGaps({ limit: "2", offset: "0" });
  assert.equal(page1.body.items.length, 2);
  assert.equal(page1.body.counts.total, 3, "counts are unpaged");
  const page2 = await callGaps({ limit: "2", offset: "2" });
  assert.equal(page2.body.items.length, 1);
  assert.deepEqual(
    [...page1.body.items, ...page2.body.items].map((item) => item.path),
    paths,
    "pages must be stable and ordered by rowid",
  );
  for (const item of [...page1.body.items, ...page2.body.items]) {
    assert.deepEqual(item.missing, ["art", "albumMbid"]);
  }

  assert.equal((await callGaps({ limit: "0" })).body.limit, 100, "0 falls back to the default");
  assert.equal((await callGaps({ limit: "abc" })).body.limit, 100, "NaN falls back to the default");
  assert.equal((await callGaps({ limit: "99999" })).body.limit, 500, "limit is capped");
  assert.equal((await callGaps({ offset: "-4" })).body.offset, 0, "a negative offset is clamped");
  assert.deepEqual((await callGaps({ offset: "999" })).body.items, [], "past the end is empty");
});
