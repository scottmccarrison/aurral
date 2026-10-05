import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseFile } from "music-metadata";

import axios from "../../lib/axiosFetch.js";
import { dbOps } from "../../backend/db/helpers/index.js";
import {
  enrichDownloadedTrack,
  writeAudioCover,
  writeAudioMetadata,
} from "../../backend/services/playlistDownloadUtils.js";
import { inFlightCoverFetches, resolveCoverArtBytes } from "../../backend/services/coverArtService.js";
import {
  caaImageCache,
  fetchCoverArtArchiveFront,
} from "../../backend/services/apiClients/coverArtArchive.js";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "aurral-cover-art-"));

const TRACK = {
  trackName: "Bonzo Goes to Bitburg",
  artistName: "Ramones",
  albumName: "Animal Boy",
  artistMbid: "11111111-1111-4111-8111-111111111111",
  albumMbid: "22222222-2222-4222-8222-222222222222",
  trackMbid: "33333333-3333-4333-8333-333333333333",
  releaseYear: "1986",
  trackNumber: 5,
};

const AUDIO_ENCODERS = {
  mp3: ["-c:a", "libmp3lame"],
  flac: ["-c:a", "flac"],
  m4a: ["-c:a", "aac"],
  ogg: ["-c:a", "libvorbis"],
  wav: ["-c:a", "pcm_s16le"],
};

function runFfmpeg(args) {
  const generated = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args],
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr);
}

function createAudio(dir, name, format) {
  const filePath = path.join(dir, name);
  runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    "anullsrc",
    "-t",
    "0.05",
    ...AUDIO_ENCODERS[format],
    filePath,
  ]);
  return filePath;
}

function createImage(dir, name, color) {
  const filePath = path.join(dir, name);
  runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=64x64:d=0.05`,
    "-frames:v",
    "1",
    filePath,
  ]);
  return filePath;
}

// Real jpeg/png bytes so magic-byte sniffing and ffmpeg's mjpeg/png decoders see
// exactly what production sees.
const jpegBytes = await readFile(createImage(tempDir, "fixture-red.jpg", "red"));
const pngBytes = await readFile(createImage(tempDir, "fixture-blue.png", "blue"));
const otherJpegBytes = await readFile(createImage(tempDir, "fixture-green.jpg", "green"));

/**
 * Fresh staging + library pair per case. Sidecars are fill-only, so sharing a
 * directory between cases would make "was it created?" unanswerable.
 */
async function createCase(name, format) {
  const stagingDir = path.join(tempDir, name, "staging");
  const finalDir = path.join(tempDir, name, "library");
  await mkdir(stagingDir, { recursive: true });
  const stagingPath = createAudio(stagingDir, `track.${format}`, format);
  return { stagingDir, finalDir, stagingPath };
}

const exists = async (target) => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

const cover = (bytes, mime) => ({ bytes, mime, source: "test" });

const pictures = async (filePath) => {
  const { common } = await parseFile(filePath, { skipCovers: false });
  return common.picture || [];
};

// ---------------------------------------------------------------------------
// 1. Embedding, per container
// ---------------------------------------------------------------------------

for (const format of ["mp3", "flac", "m4a"]) {
  test(`embeds jpeg cover art into ${format} downloads`, async () => {
    const { stagingPath, finalDir } = await createCase(`embed-jpeg-${format}`, format);

    const result = await enrichDownloadedTrack(stagingPath, finalDir, TRACK, {
      cover: cover(jpegBytes, "image/jpeg"),
    });

    assert.equal(result.embedded, true, `${format} must accept an attached picture`);
    const { common } = await parseFile(stagingPath);
    assert.ok(
      common.picture?.length >= 1,
      `${format} should carry at least one embedded picture`,
    );
    assert.equal(common.picture[0].format, "image/jpeg");
    assert.deepEqual(Buffer.from(common.picture[0].data), jpegBytes);
    // Tags are written first and survive the cover pass.
    assert.equal(common.title, TRACK.trackName);
    assert.equal(common.album, TRACK.albumName);
    assert.equal(common.artist, TRACK.artistName);
  });
}

test("embeds png cover art using the png codec", async () => {
  const { stagingPath, finalDir } = await createCase("embed-png-mp3", "mp3");

  const result = await enrichDownloadedTrack(stagingPath, finalDir, TRACK, {
    cover: cover(pngBytes, "image/png"),
  });

  assert.equal(result.embedded, true);
  const found = await pictures(stagingPath);
  assert.equal(found.length, 1);
  assert.equal(found[0].format, "image/png");
  assert.deepEqual(Buffer.from(found[0].data), pngBytes);
});

// ---------------------------------------------------------------------------
// 2. Containers ffmpeg cannot attach pictures to
// ---------------------------------------------------------------------------

for (const format of ["ogg", "wav"]) {
  test(`${format} downloads are sidecar-only`, async () => {
    const { stagingPath, finalDir } = await createCase(`sidecar-only-${format}`, format);

    const result = await enrichDownloadedTrack(stagingPath, finalDir, TRACK, {
      cover: cover(jpegBytes, "image/jpeg"),
    });

    assert.equal(result.embedded, false, `${format} must not attempt an embed`);
    assert.deepEqual(result.sidecarsWritten, [
      path.join(finalDir, "cover.jpg"),
      path.join(finalDir, "folder.jpg"),
    ]);
    assert.equal((await pictures(stagingPath)).length, 0);
    const { common } = await parseFile(stagingPath);
    assert.equal(common.title, TRACK.trackName);
  });
}

// ---------------------------------------------------------------------------
// 3. Sidecar placement and fill-only behaviour
// ---------------------------------------------------------------------------

test("writes sidecars into the library dir, never the staging dir", async () => {
  const { stagingPath, stagingDir, finalDir } = await createCase("sidecar-target", "mp3");
  await mkdir(finalDir, { recursive: true });
  await writeFile(path.join(finalDir, "cover.jpg"), otherJpegBytes);

  const result = await enrichDownloadedTrack(stagingPath, finalDir, TRACK, {
    cover: cover(jpegBytes, "image/jpeg"),
  });

  // cover.jpg already existed: fill-only leaves it byte-identical.
  assert.deepEqual(result.sidecarsWritten, [path.join(finalDir, "folder.jpg")]);
  assert.deepEqual(await readFile(path.join(finalDir, "cover.jpg")), otherJpegBytes);
  assert.deepEqual(await readFile(path.join(finalDir, "folder.jpg")), jpegBytes);
  assert.equal(await exists(path.join(stagingDir, "cover.jpg")), false);
  assert.equal(await exists(path.join(stagingDir, "folder.jpg")), false);
});

test("writeAudioCover defaults sidecars to the audio directory and keeps png bytes", async () => {
  const { stagingPath, stagingDir } = await createCase("sidecar-default-dir", "flac");

  const result = await writeAudioCover(stagingPath, { bytes: pngBytes, mime: "image/png" });

  assert.equal(result.embedded, true);
  assert.deepEqual(result.sidecarsWritten, [
    path.join(stagingDir, "cover.jpg"),
    path.join(stagingDir, "folder.jpg"),
  ]);
  // *arr/Navidrome convention: the names stay cover.jpg/folder.jpg and Navidrome
  // sniffs the content, so png bytes are written as received.
  assert.deepEqual(await readFile(path.join(stagingDir, "cover.jpg")), pngBytes);
});

// ---------------------------------------------------------------------------
// 4. Art already embedded in the file
// ---------------------------------------------------------------------------

test("does not stack a second picture when art is already embedded", async () => {
  const { stagingPath, finalDir } = await createCase("existing-picture", "mp3");
  const first = await writeAudioCover(
    stagingPath,
    { bytes: otherJpegBytes, mime: "image/jpeg" },
    { sidecar: false },
  );
  assert.equal(first.embedded, true);

  const result = await enrichDownloadedTrack(stagingPath, finalDir, TRACK, {
    cover: cover(jpegBytes, "image/jpeg"),
  });

  assert.equal(result.embedded, false);
  const found = await pictures(stagingPath);
  assert.equal(found.length, 1, "existing cover must not be duplicated");
  assert.deepEqual(Buffer.from(found[0].data), otherJpegBytes);
  const { common } = await parseFile(stagingPath);
  assert.equal(common.title, TRACK.trackName);
  // Sidecars are still filled even though the embed was skipped.
  assert.deepEqual(result.sidecarsWritten, [
    path.join(finalDir, "cover.jpg"),
    path.join(finalDir, "folder.jpg"),
  ]);
});

// ---------------------------------------------------------------------------
// 5. Tier 0 - art beside the source file
// ---------------------------------------------------------------------------

test("adopts a source-sidecar cover without calling the resolver", async () => {
  const { stagingPath, stagingDir, finalDir } = await createCase("source-sidecar", "mp3");
  await writeFile(path.join(stagingDir, "cover.jpg"), otherJpegBytes);

  let resolverCalls = 0;
  const result = await enrichDownloadedTrack(stagingPath, finalDir, TRACK, {
    resolveCover: async () => {
      resolverCalls += 1;
      return cover(jpegBytes, "image/jpeg");
    },
  });

  assert.equal(resolverCalls, 0, "tier 0 must short-circuit the network tier");
  assert.equal(result.embedded, true);
  const found = await pictures(stagingPath);
  assert.equal(found.length, 1);
  assert.deepEqual(Buffer.from(found[0].data), otherJpegBytes);
});

// ---------------------------------------------------------------------------
// 6. Tier order inside resolveCoverArtBytes (all network injected)
// ---------------------------------------------------------------------------

test("prefers Cover Art Archive and falls back to the URL chain", async () => {
  const urlChainCalls = [];

  const caaHit = await resolveCoverArtBytes("aaaaaaaa-0000-4000-8000-000000000001", {
    fetchCaa: async () => ({
      bytes: jpegBytes,
      mime: "image/jpeg",
      notFound: false,
      transientError: false,
    }),
    resolveUrl: async (mbid) => {
      urlChainCalls.push(`resolve:${mbid}`);
      return { imageUrl: "https://cover.invalid/a.jpg", notFound: false, transientError: false };
    },
    fetchBytes: async (url) => {
      urlChainCalls.push(`fetch:${url}`);
      return { bytes: pngBytes, mime: "image/png" };
    },
  });
  assert.equal(caaHit.source, "caa");
  assert.equal(caaHit.mime, "image/jpeg");
  assert.deepEqual(caaHit.bytes, jpegBytes);
  assert.deepEqual(urlChainCalls, [], "a CAA hit must not touch the URL chain");

  const afterNotFound = await resolveCoverArtBytes("aaaaaaaa-0000-4000-8000-000000000002", {
    fetchCaa: async () => ({ bytes: null, mime: null, notFound: true, transientError: false }),
    resolveUrl: async () => ({
      imageUrl: "https://cover.invalid/b.png",
      notFound: false,
      transientError: false,
    }),
    fetchBytes: async (url) => {
      urlChainCalls.push(`fetch:${url}`);
      return { bytes: pngBytes, mime: "image/png" };
    },
  });
  assert.equal(afterNotFound.source, "url-chain");
  assert.equal(afterNotFound.mime, "image/png");
  assert.deepEqual(urlChainCalls, ["fetch:https://cover.invalid/b.png"]);

  const afterTransient = await resolveCoverArtBytes("aaaaaaaa-0000-4000-8000-000000000003", {
    fetchCaa: async () => ({ bytes: null, mime: null, notFound: false, transientError: true }),
    resolveUrl: async () => ({
      imageUrl: "https://cover.invalid/c.jpg",
      notFound: false,
      transientError: false,
    }),
    fetchBytes: async () => ({ bytes: jpegBytes, mime: "image/jpeg" }),
  });
  assert.equal(afterTransient.source, "url-chain");

  const exhausted = await resolveCoverArtBytes("aaaaaaaa-0000-4000-8000-000000000004", {
    fetchCaa: async () => ({ bytes: null, mime: null, notFound: true, transientError: false }),
    resolveUrl: async () => ({ imageUrl: null, notFound: true, transientError: false }),
    fetchBytes: async () => {
      throw new Error("fetchBytes must not run without a URL");
    },
  });
  assert.equal(exhausted, null);

  let tierCalls = 0;
  const countingFake = async () => {
    tierCalls += 1;
    return null;
  };
  const nullMbid = await resolveCoverArtBytes(null, {
    fetchCaa: countingFake,
    resolveUrl: countingFake,
    fetchBytes: countingFake,
  });
  assert.equal(nullMbid, null);
  assert.equal(tierCalls, 0, "a missing MBID must return immediately");
});

test("concurrent resolves for one mbid share a single fetch (singleflight)", async () => {
  const mbid = "aaaaaaaa-0000-4000-8000-0000000000f1";
  let caaCalls = 0;
  // Each caller injects its OWN fake deps; only the first caller's fetcher may
  // run - the second must join the in-flight promise instead of re-fetching.
  const fakeDeps = () => ({
    fetchCaa: async () => {
      caaCalls += 1;
      // Hold the fetch open so both callers are provably concurrent.
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { bytes: jpegBytes, mime: "image/jpeg", notFound: false, transientError: false };
    },
    resolveUrl: async () => ({ imageUrl: null, notFound: true, transientError: false }),
    fetchBytes: async () => null,
  });

  const [first, second] = await Promise.all([
    resolveCoverArtBytes(mbid, fakeDeps()),
    resolveCoverArtBytes(mbid, fakeDeps()),
  ]);

  assert.equal(caaCalls, 1, "the in-flight promise must be shared, not re-fetched");
  assert.equal(first.source, "caa");
  assert.equal(first, second, "both callers receive the identical result object");
  assert.equal(inFlightCoverFetches.size, 0, "the in-flight entry is cleared once settled");

  // Injected fakes are never TTL-cached: a later sequential call fetches again
  // (proves the finally-cleanup did not leave a stale entry behind).
  const third = await resolveCoverArtBytes(mbid, fakeDeps());
  assert.equal(caaCalls, 2, "a settled fetch must not stay pinned in the map");
  assert.deepEqual(third, first);
  assert.equal(inFlightCoverFetches.size, 0);
});

test("writes tags and no sidecars when every art tier fails", async () => {
  const { stagingPath, finalDir } = await createCase("no-art", "mp3");

  const result = await enrichDownloadedTrack(stagingPath, finalDir, TRACK, {
    resolveCover: async () => null,
  });

  assert.equal(result, null);
  assert.equal(await exists(path.join(finalDir, "cover.jpg")), false);
  assert.equal(await exists(path.join(finalDir, "folder.jpg")), false);
  const { common } = await parseFile(stagingPath);
  assert.equal(common.title, TRACK.trackName);
  assert.equal(common.album, TRACK.albumName);
});

// ---------------------------------------------------------------------------
// 7. Settings flags
// ---------------------------------------------------------------------------

test("embedCoverArt:false skips the embed but still writes sidecars", async (t) => {
  t.mock.method(dbOps, "getSettings", () => ({ enrichment: { embedCoverArt: false } }));
  const { stagingPath, finalDir } = await createCase("flag-no-embed", "mp3");

  const result = await enrichDownloadedTrack(stagingPath, finalDir, TRACK, {
    cover: cover(jpegBytes, "image/jpeg"),
  });

  assert.equal(result.embedded, false);
  assert.equal((await pictures(stagingPath)).length, 0);
  assert.deepEqual(result.sidecarsWritten, [
    path.join(finalDir, "cover.jpg"),
    path.join(finalDir, "folder.jpg"),
  ]);
});

test("sidecarCoverArt:false embeds but writes no sidecars", async (t) => {
  t.mock.method(dbOps, "getSettings", () => ({ enrichment: { sidecarCoverArt: false } }));
  const { stagingPath, finalDir } = await createCase("flag-no-sidecar", "mp3");

  const result = await enrichDownloadedTrack(stagingPath, finalDir, TRACK, {
    cover: cover(jpegBytes, "image/jpeg"),
  });

  assert.equal(result.embedded, true);
  assert.deepEqual(result.sidecarsWritten, []);
  assert.equal(await exists(path.join(finalDir, "cover.jpg")), false);
  assert.equal((await pictures(stagingPath)).length, 1);
});

test("both cover art flags default ON when the enrichment block is absent", async (t) => {
  t.mock.method(dbOps, "getSettings", () => ({}));
  const { stagingPath, finalDir } = await createCase("flag-defaults", "flac");

  const result = await enrichDownloadedTrack(stagingPath, finalDir, TRACK, {
    cover: cover(jpegBytes, "image/jpeg"),
  });

  assert.equal(result.embedded, true);
  assert.deepEqual(result.sidecarsWritten, [
    path.join(finalDir, "cover.jpg"),
    path.join(finalDir, "folder.jpg"),
  ]);
});

test("both flags off leaves the file tagged but untouched by art", async (t) => {
  t.mock.method(dbOps, "getSettings", () => ({
    enrichment: { embedCoverArt: false, sidecarCoverArt: false },
  }));
  const { stagingPath, finalDir } = await createCase("flag-both-off", "mp3");

  const result = await enrichDownloadedTrack(stagingPath, finalDir, TRACK, {
    cover: cover(jpegBytes, "image/jpeg"),
  });

  assert.equal(result, null);
  assert.equal((await pictures(stagingPath)).length, 0);
  assert.equal(await exists(path.join(finalDir, "cover.jpg")), false);
  const { common } = await parseFile(stagingPath);
  assert.equal(common.title, TRACK.trackName);
});

// ---------------------------------------------------------------------------
// 8. Art failures must never fail a download
// ---------------------------------------------------------------------------

test("a throwing resolver still leaves a tagged file and never throws", async () => {
  const { stagingPath, finalDir } = await createCase("resolver-throws", "flac");

  const result = await enrichDownloadedTrack(stagingPath, finalDir, TRACK, {
    resolveCover: async () => {
      throw new Error("resolver exploded");
    },
  });

  assert.equal(result, null);
  const { common } = await parseFile(stagingPath);
  assert.equal(common.title, TRACK.trackName);
  assert.equal(common.album, TRACK.albumName);
  assert.equal(common.track.no, TRACK.trackNumber);
});

test("unusable cover bytes are ignored instead of embedded", async () => {
  const { stagingPath, finalDir } = await createCase("bogus-bytes", "mp3");

  const result = await enrichDownloadedTrack(stagingPath, finalDir, TRACK, {
    cover: { bytes: Buffer.from("<html>not art</html>"), mime: "image/jpeg" },
  });

  // Not a jpeg/png payload: nothing is attached and no sidecar is written.
  assert.deepEqual(result, { embedded: false, sidecarsWritten: [] });
  assert.equal((await pictures(stagingPath)).length, 0);
  assert.equal(await exists(path.join(finalDir, "cover.jpg")), false);
  assert.equal(await exists(path.join(finalDir, "folder.jpg")), false);
  const { common } = await parseFile(stagingPath);
  assert.equal(common.title, TRACK.trackName);
});

// ---------------------------------------------------------------------------
// Cover Art Archive client (axios is the injected fake; no network)
// ---------------------------------------------------------------------------

test("fetchCoverArtArchiveFront validates payloads and caches outcomes", async (t) => {
  caaImageCache.flushAll();
  const requests = [];
  t.mock.method(axios, "get", async (url, config) => {
    requests.push({ url, config });
    // Matched on the unique mbid tail: the URL carries the encoded mbid, so a
    // full-mbid substring would have to be duplicated in three places.
    if (url.includes("000000000404")) {
      const error = new Error("Request failed with status code 404");
      error.response = { status: 404 };
      throw error;
    }
    if (url.includes("000000000500")) {
      const error = new Error("Request failed with status code 503");
      error.response = { status: 503 };
      throw error;
    }
    if (url.includes("000000000html")) {
      return { status: 200, data: Buffer.from("<html>rate limited</html>") };
    }
    return { status: 200, data: jpegBytes };
  });

  const hitMbid = "aaaaaaaa-0000-4000-8000-0000000000aa";
  const hit = await fetchCoverArtArchiveFront(hitMbid);
  assert.deepEqual(hit, {
    bytes: jpegBytes,
    mime: "image/jpeg",
    notFound: false,
    transientError: false,
  });
  assert.equal(
    requests[0].url,
    `https://coverartarchive.org/release-group/${hitMbid}/front-1200`,
  );
  assert.equal(requests[0].config.responseType, "arraybuffer");
  assert.equal(requests[0].config.timeout, 10000);
  assert.equal(requests[0].config.maxContentLength, 15 * 1024 * 1024);
  assert.equal(requests[0].config.maxRedirects, 5);

  // Bytes are memoized in memory, so the second call is free.
  const requestCountAfterHit = requests.length;
  const cachedHit = await fetchCoverArtArchiveFront(hitMbid);
  assert.equal(cachedHit.mime, "image/jpeg");
  assert.equal(requests.length, requestCountAfterHit);

  const notFoundMbid = "aaaaaaaa-0000-4000-8000-000000000404";
  const notFound = await fetchCoverArtArchiveFront(notFoundMbid);
  assert.deepEqual(notFound, {
    bytes: null,
    mime: null,
    notFound: true,
    transientError: false,
  });
  assert.equal(dbOps.getImage(`caa:rg:${notFoundMbid}`)?.imageUrl, "NOT_FOUND");
  const requestCountAfterNotFound = requests.length;
  const cachedNotFound = await fetchCoverArtArchiveFront(notFoundMbid);
  assert.equal(cachedNotFound.notFound, true);
  assert.equal(
    requests.length,
    requestCountAfterNotFound,
    "a cached NOT_FOUND sentinel must not re-request CAA",
  );

  const serverError = await fetchCoverArtArchiveFront(
    "aaaaaaaa-0000-4000-8000-000000000500",
  );
  assert.deepEqual(serverError, {
    bytes: null,
    mime: null,
    notFound: false,
    transientError: true,
  });

  const htmlBody = await fetchCoverArtArchiveFront(
    "aaaaaaaa-0000-4000-8000-000000000html",
  );
  assert.deepEqual(htmlBody, {
    bytes: null,
    mime: null,
    notFound: false,
    transientError: true,
  });

  assert.deepEqual(await fetchCoverArtArchiveFront(""), {
    bytes: null,
    mime: null,
    notFound: true,
    transientError: false,
  });
});

// ---------------------------------------------------------------------------
// 9. Tag preservation across a metadata rewrite (data-loss proof)
// ---------------------------------------------------------------------------

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

const pngFixturePath = path.join(tempDir, "fixture-blue.png");

for (const format of ["mp3", "flac"]) {
  test(`writeAudioMetadata preserves legacy tags and embedded pictures (${format})`, async () => {
    const { stagingDir, stagingPath } = await createCase(`tag-preservation-${format}`, format);
    // Legacy-library fixture: non-whitelisted custom tags (genre/comment/
    // lyrics-style) plus an embedded picture - exactly what a re-tag of an
    // old file must not destroy.
    const legacyPath = path.join(stagingDir, `legacy.${format}`);
    runFfmpeg([
      "-i", stagingPath, "-map", "0", "-c", "copy",
      "-metadata", "genre=Punk",
      "-metadata", "comment=legacy rip comment",
      "-metadata", "lyrics=legacy lyrics line",
      legacyPath,
    ]);
    const artPath = path.join(stagingDir, `art.${format}`);
    runFfmpeg([
      "-i", legacyPath, "-i", pngFixturePath,
      "-map", "0:a", "-map", "1:v", "-c:a", "copy", "-c:v", "copy",
      "-disposition:v", "attached_pic",
      artPath,
    ]);
    await rename(artPath, stagingPath);
    await rm(legacyPath, { force: true });

    const before = await parseFile(stagingPath, { skipCovers: false });
    assert.deepEqual(before.common.genre, ["Punk"], "fixture must carry the custom genre");
    assert.equal(before.common.picture?.length, 1, "fixture must carry an embedded picture");
    const beforeTags = nativeScalarTags(before);
    assert.ok(beforeTags.size >= 4, "fixture must carry the custom tags");

    // The rewrite under test: one MBID-ish key set, written through the real
    // ffmpeg `-map 0 -c copy` + `-metadata` path.
    await writeAudioMetadata(stagingPath, { albumMbid: TRACK.albumMbid });

    const after = await parseFile(stagingPath, { skipCovers: false });
    // Every scalar native tag present before the rewrite survives with its
    // exact value (mp3: TCON / TXXX:comment / TXXX:USLT; flac: GENRE /
    // DESCRIPTION / LYRICS).
    const afterTags = nativeScalarTags(after);
    for (const [id, value] of beforeTags) {
      assert.equal(afterTags.get(id), value, `native tag ${id} must survive the rewrite`);
    }
    assert.deepEqual(after.common.genre, ["Punk"], "genre must survive");
    assert.equal(after.common.picture?.length, 1, "the embedded picture must survive");
    assert.equal(after.common.picture[0].format, "image/png");
    assert.deepEqual(
      Buffer.from(after.common.picture[0].data),
      Buffer.from(before.common.picture[0].data),
      "picture bytes must be identical",
    );
    // Proof the rewrite really happened: flac maps the new keys onto common;
    // mp3 keeps them as TXXX frames whose lowercase descriptions
    // music-metadata does not map (documented ffmpeg/mp3 quirk), so they are
    // asserted at the native level instead.
    if (format === "flac") {
      assert.equal(after.common.musicbrainz_albumid, TRACK.albumMbid);
      assert.equal(after.common.musicbrainz_releasegroupid, TRACK.albumMbid);
    } else {
      assert.equal(afterTags.get("TXXX:musicbrainz_albumid"), TRACK.albumMbid);
      assert.equal(afterTags.get("TXXX:musicbrainz_releasegroupid"), TRACK.albumMbid);
    }
  });
}

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});
