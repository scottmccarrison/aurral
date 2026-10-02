// Album-version-aware post-download validation (issue #5).
//
// Covers acceptance scenarios a–g: edition renumbering confirmed through the
// FILE's own release tracklist, multi-disc (disc-local) numbering, the
// same-edition mismatch reason, the tracklist-unavailable fallback to the
// configurable tolerance patch, the requireExactAlbumMatch hard gate,
// recording-MBID identity, and the detectAlbumVersion/albumNamesVariant units.
//
// Harness (beets-free, DB-free — mirrors post-download.test.js):
//   - python3 + .tests/fixtures/matcher/stub_ok.py answer the track_distance
//     call with a canned strong match via STUB_MATCHER_RESPONSE. The stubbed
//     response MUST carry protocol: 1 (beetsClient.js:164).
//   - parseFile is injected, so no real audio files are read.
//   - fetchReleaseTracklist is injected, so the edition path never reaches
//     MusicBrainz and the validator never touches the DB.
//
// The asserted reason strings pin the identityPolicy.js step order:
//   (1) recording-MBID identity → (3) edition tracklist confirmation →
//   (4) sibling-title conflict → (5) tolerance patch → (6) exact-album gate.

import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import {
  validateDownloadedTrackFile,
  detectAlbumVersion,
  albumNamesVariant,
  POST_DOWNLOAD_DECISIONS,
} from "../../backend/services/trackMatching/index.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "matcher",
);
const stub = (name) => path.join(fixturesDir, name);

// Gate exactly like beets-client.test.js: the stub matcher only needs python3.
const hasSystemPython = (() => {
  const probe = spawnSync("python3", ["-c", "print(1)"], { timeout: 5000 });
  return probe.status === 0;
})();
const skip = hasSystemPython ? false : "python3 unavailable";
const ptest = (name, fn) => test(name, { skip }, fn);

// Canned strong match: distance below strongRecThresh (0.04), zero title and
// artist penalties → tagsMatchStrongly in identityPolicy.js.
process.env.STUB_MATCHER_RESPONSE = JSON.stringify({
  ok: true,
  protocol: 1,
  operation: "track_distance",
  beetsVersion: "stub-1.0.0",
  matches: [
    {
      candidateIndex: 0,
      distance: 0.02,
      maxDistance: 0.02,
      rawDistance: 0.02,
      penalties: { track_title: 0, track_artist: 0 },
    },
  ],
});

const MATCHER = {
  pythonPath: "python3",
  scriptPath: stub("stub_ok.py"),
  timeoutMs: 10000,
};

// Quality-passing stub format: lossless / 44100 / 16-bit / 900kbps → the
// flac-standard tier, enabled in the default quality profile.
function stubParsed(tags = {}, durationSec = 200) {
  return {
    common: {
      title: tags.title ?? null,
      artist: tags.artist ?? null,
      album: tags.album ?? null,
      track: { no: tags.track ?? null },
      disc: { no: tags.disc ?? null },
      musicbrainz_recordingid: tags.mbid,
      musicbrainz_albumid: tags.albumid,
    },
    format: {
      duration: durationSec,
      lossless: true,
      sampleRate: 44100,
      bitsPerSample: 16,
      bitrate: 900000,
      container: "FLAC",
      codec: "FLAC",
    },
  };
}

const stubParseFile = (parsed) => async () => parsed;

// Injected fetchReleaseTracklist that records the release MBIDs requested.
function tracklistMock(tracklist) {
  const calls = [];
  return {
    calls,
    fetchReleaseTracklist: async (releaseMbid) => {
      calls.push(releaseMbid);
      return tracklist;
    },
  };
}

const DELUXE_RELEASE_MBID = "9c1f1a0e-4b2d-4e8a-9f3c-2d1e0f9a8b7c";

// The issue's scenario: "Calico Creek (Acoustic)" is track 15 on the standard
// edition and track 34 on the deluxe edition. Request AND file titles both
// carry "(Acoustic)" so the variant-contradiction policy stays quiet.
const CALICO_REQUEST = {
  artistName: "The Hollow Oaks",
  trackName: "Calico Creek (Acoustic)",
  albumName: "Calico Creek",
  trackNumber: 15,
  durationMs: 200000,
};

// Standard-edition tracklist. Kept at 15 entries (≤ 16) so the deluxe file's
// flat index 34 cannot exist here — no siblingAtIndex false positives.
const STANDARD_TRACK_TITLES = [
  "Harbor Lights",
  "Willow Lane",
  "The Long Way Home",
  "Paper Lanterns",
  "Cedar Grove",
  "Midnight Ferry",
  "The Orchard",
  "Salt and Stone",
  "Northern Line",
  "The Wren",
  "Copper Kettle",
  "Ashford Bridge",
  "The Miller's Daughter",
  "Lantern Road",
  "Calico Creek (Acoustic)",
];

// Same standard edition, but the requested track is "River Song" (track 15);
// track 7 is a different song, so a file claiming track 7 names a sibling.
const RIVER_TRACK_TITLES = STANDARD_TRACK_TITLES.map((title, index) =>
  index === 14 ? "River Song" : title,
);

const RIVER_REQUEST = {
  artistName: "The Hollow Oaks",
  trackName: "River Song",
  albumName: "Calico Creek",
  trackNumber: 15,
  durationMs: 200000,
};

// The downloaded deluxe-edition file: strong title/artist, track 34, its own
// release MBID, and NO recording MBID (the edition path must decide).
const DELUXE_FILE_TAGS = {
  title: "Calico Creek (Acoustic)",
  artist: "The Hollow Oaks",
  album: "Calico Creek (Deluxe)",
  track: 34,
  albumid: DELUXE_RELEASE_MBID,
};

// Deluxe-edition tracklist: (disc 1, position 34) carries the file's title.
const DELUXE_TRACKLIST = [
  { discNumber: 1, trackNumber: 15, title: "Calico Creek" },
  { discNumber: 1, trackNumber: 33, title: "Willow Lane" },
  { discNumber: 1, trackNumber: 34, title: "Calico Creek (Acoustic)" },
];

// --- a. Calico Creek edition path -------------------------------------------

ptest("a: deluxe renumbering confirmed by the file's own release tracklist verifies", async () => {
  const mock = tracklistMock(DELUXE_TRACKLIST);
  const outcome = await validateDownloadedTrackFile({
    request: { ...CALICO_REQUEST, albumTrackTitles: STANDARD_TRACK_TITLES },
    filePath: "/staging/34 - Calico Creek (Acoustic).flac",
    source: "soulseek",
    options: {
      ...MATCHER,
      parseFile: stubParseFile(stubParsed(DELUXE_FILE_TAGS)),
      fetchReleaseTracklist: mock.fetchReleaseTracklist,
    },
  });
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.VERIFIED);
  assert.equal(outcome.reason, "edition renumbering confirmed");
  assert.equal(outcome.valid, true);
  assert.equal(outcome.blocked, false);
  assert.equal(outcome.beets.recommendation, "strong");
  assert.equal(outcome.parsedTags.trackNumber, 34, "evidence is the file's original tag");
  assert.deepEqual(mock.calls, [DELUXE_RELEASE_MBID], "only the FILE's release MBID is looked up");
});

ptest("a: edition confirmation still verifies with trackNumberMismatchTolerance disabled", async () => {
  const mock = tracklistMock(DELUXE_TRACKLIST);
  const outcome = await validateDownloadedTrackFile({
    request: { ...CALICO_REQUEST, albumTrackTitles: STANDARD_TRACK_TITLES },
    filePath: "/staging/34 - Calico Creek (Acoustic).flac",
    source: "soulseek",
    options: {
      ...MATCHER,
      parseFile: stubParseFile(stubParsed(DELUXE_FILE_TAGS)),
      fetchReleaseTracklist: mock.fetchReleaseTracklist,
      settings: { matching: { trackNumberMismatchTolerance: false } },
    },
  });
  // With the tolerance patch disabled, only the edition path can produce
  // VERIFIED — and its reason string proves which branch decided (the
  // tolerance patch verifies with reason null; see scenario d).
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.VERIFIED);
  assert.equal(outcome.reason, "edition renumbering confirmed");
});

// --- b. Multi-disc deluxe ----------------------------------------------------

ptest("b: multi-disc deluxe confirms the disc-local position (disc 2, track 9)", async () => {
  const mock = tracklistMock([
    { discNumber: 1, trackNumber: 9, title: "Willow Lane" }, // decoy: same position, wrong medium
    { discNumber: 2, trackNumber: 1, title: "Harbor Lights" },
    { discNumber: 2, trackNumber: 9, title: "Calico Creek (Acoustic)" },
  ]);
  const outcome = await validateDownloadedTrackFile({
    request: CALICO_REQUEST,
    filePath: "/staging/2-09 - Calico Creek (Acoustic).flac",
    source: "soulseek",
    options: {
      ...MATCHER,
      parseFile: stubParseFile(
        stubParsed({
          ...DELUXE_FILE_TAGS,
          album: "Calico Creek (Deluxe Edition)",
          track: 9,
          disc: 2,
        }),
      ),
      fetchReleaseTracklist: mock.fetchReleaseTracklist,
    },
  });
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.VERIFIED);
  assert.equal(outcome.reason, "edition renumbering confirmed");
  assert.deepEqual(mock.calls, [DELUXE_RELEASE_MBID]);
});

// --- c. Same-edition mismatch ------------------------------------------------

ptest("c: same-edition track number mismatch is AMBIGUOUS with an accurate reason when tolerance is off", async () => {
  const outcome = await validateDownloadedTrackFile({
    request: RIVER_REQUEST, // no albumTrackTitles → no sibling evidence
    filePath: "/staging/07 - River Song.flac",
    source: "soulseek",
    options: {
      ...MATCHER,
      parseFile: stubParseFile(
        stubParsed({
          title: "River Song",
          artist: "The Hollow Oaks",
          album: "Calico Creek", // same known edition as the request
          track: 7,
        }),
      ),
      settings: { matching: { trackNumberMismatchTolerance: false } },
    },
  });
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.AMBIGUOUS);
  assert.equal(outcome.blocked, true);
  assert.match(outcome.reason, /track number mismatch: expected 15, actual 7/i);
  // The old wrong string blamed duration; the reason must name the real issue.
  assert.ok(
    !/duration/i.test(outcome.reason),
    `reason must not claim duration conflicts: ${outcome.reason}`,
  );
});

ptest("c: a sibling title at the file's claimed index conflicts even with tolerance on", async () => {
  const outcome = await validateDownloadedTrackFile({
    // Track 7 of the requested release is "Salt and Stone", so a file tagged
    // "River Song" at track 7 contradicts the requested release's numbering.
    request: { ...RIVER_REQUEST, albumTrackTitles: RIVER_TRACK_TITLES },
    filePath: "/staging/07 - River Song.flac",
    source: "soulseek",
    options: {
      ...MATCHER,
      parseFile: stubParseFile(
        stubParsed({
          title: "River Song",
          artist: "The Hollow Oaks",
          album: "Calico Creek",
          track: 7,
        }),
      ),
    },
  });
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.CONFLICTED);
  assert.equal(outcome.valid, false);
  assert.equal(outcome.blocked, false);
  assert.match(outcome.reason, /sibling track/i);
});

// --- d. Tracklist unavailable → tolerance patch fallback ---------------------

ptest("d: unavailable tracklist falls back to the tolerance patch and verifies", async () => {
  const mock = tracklistMock(null);
  const outcome = await validateDownloadedTrackFile({
    request: { ...CALICO_REQUEST, albumTrackTitles: STANDARD_TRACK_TITLES },
    filePath: "/staging/34 - Calico Creek (Acoustic).flac",
    source: "soulseek",
    options: {
      ...MATCHER,
      parseFile: stubParseFile(stubParsed(DELUXE_FILE_TAGS)),
      fetchReleaseTracklist: mock.fetchReleaseTracklist,
    },
  });
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.VERIFIED);
  assert.equal(outcome.reason, null, "the tolerance patch verifies without an edition reason");
  assert.deepEqual(mock.calls, [DELUXE_RELEASE_MBID], "the fetch was attempted and returned null");
});

ptest("d: unavailable tracklist with tolerance off holds the file for review", async () => {
  const mock = tracklistMock(null);
  const outcome = await validateDownloadedTrackFile({
    request: { ...CALICO_REQUEST, albumTrackTitles: STANDARD_TRACK_TITLES },
    filePath: "/staging/34 - Calico Creek (Acoustic).flac",
    source: "soulseek",
    options: {
      ...MATCHER,
      parseFile: stubParseFile(stubParsed(DELUXE_FILE_TAGS)),
      fetchReleaseTracklist: mock.fetchReleaseTracklist,
      settings: { matching: { trackNumberMismatchTolerance: false } },
    },
  });
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.AMBIGUOUS);
  assert.equal(outcome.blocked, true);
  assert.match(outcome.reason, /track number mismatch: expected 15, actual 34/i);
});

ptest("d: contradicted tracklist disables the tolerance patch and holds for review", async () => {
  // The tracklist is fetched successfully, but the title at (disc 1, position 34)
  // is DIFFERENT from the file's title. This contradicts the file's position claim,
  // which disables the trackNumberMismatchTolerance patch below.
  const contradictedTracklist = [
    { discNumber: 1, trackNumber: 15, title: "Calico Creek" },
    { discNumber: 1, trackNumber: 33, title: "Willow Lane" },
    { discNumber: 1, trackNumber: 34, title: "Different Song Title" }, // contradicts file's "Calico Creek (Acoustic)"
  ];
  const mock = tracklistMock(contradictedTracklist);
  const outcome = await validateDownloadedTrackFile({
    request: { ...CALICO_REQUEST, albumTrackTitles: STANDARD_TRACK_TITLES },
    filePath: "/staging/34 - Calico Creek (Acoustic).flac",
    source: "soulseek",
    options: {
      ...MATCHER,
      parseFile: stubParseFile(stubParsed(DELUXE_FILE_TAGS)),
      fetchReleaseTracklist: mock.fetchReleaseTracklist,
      settings: { matching: { trackNumberMismatchTolerance: true } }, // tolerance is ON
    },
  });
  // Despite tolerance being ON, the contradicted tracklist disables the patch,
  // so the file is held for review due to track number mismatch.
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.AMBIGUOUS);
  assert.equal(outcome.blocked, true);
  assert.match(outcome.reason, /track number mismatch: expected 15, actual 34/i);
  assert.deepEqual(mock.calls, [DELUXE_RELEASE_MBID], "the contradicted tracklist was fetched");
});

// --- H1 fix: sibling override skipped for unverified editions ----------------

ptest("H1a: edition-eligible + tracklist NULL → tolerance patch VERIFIED, NOT flipped to CONFLICTED by sibling override", async () => {
  // File claims track 5 (which does NOT match the request's track-5 sibling title),
  // album names differ (edition-eligible), tracklist fetch returns NULL.
  // The tolerance patch should verify, and the sibling override should be skipped
  // because editionGate.eligible is true.
  const mock = tracklistMock(null);
  const outcome = await validateDownloadedTrackFile({
    request: { ...CALICO_REQUEST, albumTrackTitles: STANDARD_TRACK_TITLES },
    filePath: "/staging/05 - Calico Creek (Acoustic).flac",
    source: "soulseek",
    options: {
      ...MATCHER,
      parseFile: stubParseFile(
        stubParsed({
          title: "Calico Creek (Acoustic)",
          artist: "The Hollow Oaks",
          album: "Calico Creek (Deluxe)", // different from request "Calico Creek" → edition-eligible
          track: 5, // file claims track 5
          albumid: DELUXE_RELEASE_MBID,
        }),
      ),
      fetchReleaseTracklist: mock.fetchReleaseTracklist,
      settings: { matching: { trackNumberMismatchTolerance: true } },
    },
  });
  // The tolerance patch should verify (tracklist unavailable, tolerance ON).
  // The sibling override should NOT flip it to CONFLICTED because editionGate.eligible is true.
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.VERIFIED);
  assert.equal(outcome.reason, null, "tolerance patch verifies without edition reason");
  assert.equal(outcome.valid, true);
  assert.deepEqual(mock.calls, [DELUXE_RELEASE_MBID], "the fetch was attempted and returned null");
});

ptest("H1b: same edition (gate NOT eligible) + sibling at index → CONFLICTED (unchanged behavior)", async () => {
  // File claims track 5, request track 15, same album name "Calico Creek" (NOT edition-eligible).
  // Track 5 of the request is "Cedar Grove" (a sibling), so siblingAtIndex is true.
  // The sibling override should flip VERIFIED to CONFLICTED because editionGate.eligible is false.
  const outcome = await validateDownloadedTrackFile({
    request: { ...RIVER_REQUEST, albumTrackTitles: RIVER_TRACK_TITLES },
    filePath: "/staging/05 - River Song.flac",
    source: "soulseek",
    options: {
      ...MATCHER,
      parseFile: stubParseFile(
        stubParsed({
          title: "River Song",
          artist: "The Hollow Oaks",
          album: "Calico Creek", // same as request → NOT edition-eligible
          track: 5,
        }),
      ),
      settings: { matching: { trackNumberMismatchTolerance: true } },
    },
  });
  // Same edition, sibling at index → CONFLICTED with sibling reason.
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.CONFLICTED);
  assert.equal(outcome.valid, false);
  assert.match(outcome.reason, /sibling track/i);
});

// --- e. requireExactAlbumMatch hard gate -------------------------------------

ptest("e: requireExactAlbumMatch caps verification at review even when the tracklist would confirm", async () => {
  const mock = tracklistMock(DELUXE_TRACKLIST); // same mock that confirms in (a)
  const outcome = await validateDownloadedTrackFile({
    request: { ...CALICO_REQUEST, albumTrackTitles: STANDARD_TRACK_TITLES },
    filePath: "/staging/34 - Calico Creek (Acoustic).flac",
    source: "soulseek",
    options: {
      ...MATCHER,
      parseFile: stubParseFile(stubParsed(DELUXE_FILE_TAGS)),
      fetchReleaseTracklist: mock.fetchReleaseTracklist,
      settings: { matching: { requireExactAlbumMatch: true } },
    },
  });
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.AMBIGUOUS);
  assert.equal(outcome.blocked, true);
  assert.match(outcome.reason, /album mismatch/i);
  // The hard gate closes the edition path before any MusicBrainz spend.
  assert.deepEqual(mock.calls, []);
});

// --- f. Recording-MBID identity ----------------------------------------------

const RIVER_MBID_REQUEST = { ...RIVER_REQUEST, trackMbid: "rec-river-song-0001" };
const RIVER_MBID_FILE_TAGS = {
  title: "River Song",
  artist: "The Hollow Oaks",
  album: "Calico Creek (Deluxe)",
  track: 34, // position claim differs; a matching MBID is decisive anyway
  mbid: "rec-river-song-0001",
};

ptest("f(i): a recording MBID matching the job's trackMbid verifies with the duration in window", async () => {
  const outcome = await validateDownloadedTrackFile({
    request: RIVER_MBID_REQUEST,
    filePath: "/staging/34 - River Song.flac",
    source: "soulseek",
    options: {
      ...MATCHER,
      parseFile: stubParseFile(stubParsed(RIVER_MBID_FILE_TAGS)),
    },
  });
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.VERIFIED);
  assert.equal(outcome.valid, true);
  assert.deepEqual(outcome.aurralEvidence.recordingMbid, {
    match: true,
    mbid: "rec-river-song-0001",
  });
});

ptest("f(ii): a matching recording MBID with duration outside the window is not verified", async () => {
  const outcome = await validateDownloadedTrackFile({
    request: RIVER_MBID_REQUEST, // expects 200000ms
    filePath: "/staging/34 - River Song.flac",
    source: "soulseek",
    options: {
      ...MATCHER,
      // 400s → a 200000ms difference, far outside even the relaxed window.
      parseFile: stubParseFile(stubParsed(RIVER_MBID_FILE_TAGS, 400)),
    },
  });
  assert.notEqual(outcome.decision, POST_DOWNLOAD_DECISIONS.VERIFIED);
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.AMBIGUOUS);
  assert.equal(outcome.blocked, true);
  assert.match(outcome.reason, /duration mismatch: expected 200000ms, actual 400000ms/i);
});

ptest("f(iii): a recording MBID conflicting with the job's trackMbid is a hard conflict", async () => {
  const outcome = await validateDownloadedTrackFile({
    request: RIVER_MBID_REQUEST,
    filePath: "/staging/River Song.flac",
    source: "soulseek",
    options: {
      ...MATCHER,
      parseFile: stubParseFile(
        stubParsed({ ...RIVER_MBID_FILE_TAGS, track: 15, mbid: "rec-different-9999" }),
      ),
    },
  });
  assert.equal(outcome.decision, POST_DOWNLOAD_DECISIONS.CONFLICTED);
  assert.equal(outcome.valid, false);
  assert.ok(outcome.contradictions.includes("recording-mbid-conflict"));
});

// --- g. detectAlbumVersion / albumNamesVariant units --------------------------

test("g: detectAlbumVersion recognizes every edition token", () => {
  const cases = [
    ["Calico Creek (Deluxe Edition)", "deluxe"],
    ["Calico Creek (Expanded)", "expanded"],
    ["Calico Creek (2011 Remaster)", "remaster"],
    ["Calico Creek (30th Anniversary Edition)", "anniversary"],
    ["Calico Creek (Bonus Edition)", "bonus"],
    ["Calico Creek (Special Edition)", "special_edition"],
    ["Calico Creek (Tour Edition)", "tour_edition"],
  ];
  for (const [album, token] of cases) {
    const result = detectAlbumVersion("Calico Creek", album);
    assert.equal(result.candidateVersion, token, `${album} → ${token}`);
    assert.equal(result.matches, false, `${album} is not the standard edition`);
    assert.equal(result.candidateUnknown, false);
    assert.equal(result.requestVersion, "standard");
  }
  // Sanity: the same known edition on both sides matches.
  const same = detectAlbumVersion("Calico Creek", "Calico Creek");
  assert.equal(same.matches, true);
  assert.equal(same.requestVersion, "standard");
  assert.equal(same.candidateVersion, "standard");
});

test("g: Deluxe Edition and Special Edition are different editions", () => {
  const result = detectAlbumVersion(
    "Calico Creek (Deluxe Edition)",
    "Calico Creek (Special Edition)",
  );
  assert.equal(result.matches, false);
  assert.equal(result.requestVersion, "deluxe");
  assert.equal(result.candidateVersion, "special_edition");
});

test("g: a null or absent candidate album is unknown, never standard", () => {
  for (const candidate of [null, undefined]) {
    const result = detectAlbumVersion("Calico Creek", candidate);
    assert.equal(result.candidateUnknown, true);
    assert.equal(result.matches, false);
    assert.equal(result.candidateVersion, "unknown");
  }
  const deluxeRequest = detectAlbumVersion("Calico Creek (Deluxe)", null);
  assert.equal(deluxeRequest.candidateUnknown, true);
  assert.equal(deluxeRequest.matches, false);
  assert.equal(deluxeRequest.requestVersion, "deluxe");
});

test("g: albumNamesVariant detects same-base different-edition pairs", () => {
  assert.equal(albumNamesVariant("Calico Creek", "Calico Creek (Deluxe)"), true);
  assert.equal(
    albumNamesVariant("Calico Creek", "Calico Creek"),
    false,
    "identical names are not variants of each other",
  );
  assert.equal(albumNamesVariant("Calico Creek", null), false);
  assert.equal(
    albumNamesVariant("Calico Creek", "Harbor Lights"),
    false,
    "different base names are not edition variants",
  );
});
