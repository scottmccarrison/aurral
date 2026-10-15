import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps },
  { downloadTracker },
  { processUsenetPipelinePayload, isUsenetQueueNameDuplicate },
  { sabnzbdClient },
  { logger },
] = await setupIsolatedBackend(
  "usenet-orchestrator-append",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/usenetOrchestrator.js",
  "backend/services/sabnzbdClient.js",
  "backend/services/logger.js",
);

test.beforeEach(() => resetDatabase(db));
test.after(async () => cleanupIsolatedState(isolatedState));

function createRelease(title, suffix = "") {
  return {
    title,
    downloadUrl: `https://indexer.test/download/${encodeURIComponent(title)}${suffix}`,
    guid: `guid-${title}${suffix}`,
    indexerId: 1,
    indexer: "Test Indexer",
  };
}

// Drives the orchestrator "download" phase against a stubbed SABnzbd client.
// Returns the pipeline result plus the recorded appendUrl calls and logger
// warn/debug invocations so each test can assert on behavior and log level.
async function runDownloadPhase(t, { queueSlots = [], appendImpl, titles }) {
  const originalSettings = dbOps.getSettings();
  dbOps.updateSettings({
    integrations: {
      sabnzbd: { enabled: true, url: "http://sabnzbd.test", apiKey: "test" },
    },
  });

  const appendCalls = [];
  const failMessages = [];
  t.mock.method(sabnzbdClient, "isConfigured", () => true);
  t.mock.method(sabnzbdClient, "api", async (mode) => {
    assert.equal(mode, "queue");
    return { queue: { slots: queueSlots } };
  });
  t.mock.method(sabnzbdClient, "appendUrl", async (request) => {
    appendCalls.push(request);
    return appendImpl(request);
  });
  const warnings = t.mock.method(logger, "warn", () => {});
  const debugs = t.mock.method(logger, "debug", () => {});

  const jobId = downloadTracker.addJob(
    { artistName: "The Lumineers", trackName: "Brightside" },
    "usenet-append-handling",
  );
  const payload = {
    jobId,
    playlistId: "usenet-append-handling",
    phase: "download",
    source: "usenet",
    track: { artistName: "The Lumineers", trackName: "Brightside" },
    candidates: titles.map((title, index) => ({
      raw: { release: createRelease(title, `-${index}`) },
    })),
    candidateIndex: 0,
  };

  try {
    const result = await processUsenetPipelinePayload(payload, {
      failOrTryNextSource: (_payload, _job, message) => {
        failMessages.push(message);
        return { failed: true, message };
      },
    });
    return {
      result,
      appendCalls,
      failMessages,
      warnings: warnings.mock.calls,
      debugs: debugs.mock.calls,
    };
  } finally {
    dbOps.updateSettings(originalSettings);
    downloadTracker.removeJob(jobId);
  }
}

test("queue name matching tolerates SABnzbd sanitization but not near misses", () => {
  // Exact match after normalization.
  assert.equal(
    isUsenetQueueNameDuplicate(
      "Artist - Album (2024) FLAC",
      "Artist - Album (2024) FLAC",
    ),
    true,
  );
  // Observed production case: SABnzbd sanitized the job name and dropped the
  // leading article, so equality and prefix checks both miss.
  assert.equal(
    isUsenetQueueNameDuplicate(
      "Lumineers.-.Brightside.2022",
      "The Lumineers - Brightside (2022) FLAC",
    ),
    true,
  );
  // Symmetric: the queue slot holds the full title, the release title is the
  // shortened form.
  assert.equal(
    isUsenetQueueNameDuplicate(
      "The Lumineers - Brightside (2022) FLAC",
      "Lumineers - Brightside (2022)",
    ),
    true,
  );
  // Different album by the same artist must NOT match.
  assert.equal(
    isUsenetQueueNameDuplicate(
      "Lumineers.-.Cleopatra.2016",
      "The Lumineers - Brightside (2022) FLAC",
    ),
    false,
  );
  // Short generic names must not match everything via substring containment.
  assert.equal(
    isUsenetQueueNameDuplicate("2022", "The Lumineers - Brightside (2022) FLAC"),
    false,
  );
  assert.equal(
    isUsenetQueueNameDuplicate("flac", "The Lumineers - Brightside (2022) FLAC"),
    false,
  );
  // Missing values never match.
  assert.equal(isUsenetQueueNameDuplicate(undefined, "Some - Title"), false);
  assert.equal(isUsenetQueueNameDuplicate("Some - Title", ""), false);
});

test("sanitized queue slot blocks the re-add and moves to the next candidate", async (t) => {
  const { result, appendCalls, warnings } = await runDownloadPhase(t, {
    queueSlots: [{ filename: "Lumineers.-.Brightside.2022" }],
    appendImpl: () => {
      throw new Error("appendUrl must not be called for a queued duplicate");
    },
    titles: [
      "The Lumineers - Brightside (2022) FLAC",
      "The Lumineers - Brightside (2022) MP3",
    ],
  });

  assert.equal(appendCalls.length, 0);
  assert.equal(result.phase, "download");
  assert.equal(result.candidateIndex, 1);
  assert.equal(result.nzbId, null);
  assert.equal(warnings.length, 0);
});

test("sanitized queue slot fails the source when no candidate remains", async (t) => {
  const { result, appendCalls, failMessages, warnings } = await runDownloadPhase(t, {
    queueSlots: [{ filename: "Lumineers.-.Brightside.2022" }],
    appendImpl: () => {
      throw new Error("appendUrl must not be called for a queued duplicate");
    },
    titles: ["The Lumineers - Brightside (2022) FLAC"],
  });

  assert.equal(appendCalls.length, 0);
  assert.equal(result.failed, true);
  assert.deepEqual(failMessages, ["Release already in SABnzbd queue"]);
  assert.equal(warnings.length, 0);
});

test("duplicate-class append rejection logs at debug level and tries the next candidate", async (t) => {
  const { result, warnings, debugs } = await runDownloadPhase(t, {
    queueSlots: [],
    appendImpl: () => {
      throw new Error("SABnzbd rejected the NZB URL: Item already exists");
    },
    titles: [
      "The Lumineers - Brightside (2022) FLAC",
      "The Lumineers - Brightside (2022) MP3",
    ],
  });

  assert.equal(warnings.length, 0);
  assert.ok(
    debugs.some(
      (call) => call.arguments[1] === "Usenet client rejected duplicate release",
    ),
  );
  assert.equal(result.phase, "download");
  assert.equal(result.candidateIndex, 1);
  assert.equal(result.nzbId, null);
});

test("duplicate-class append rejection fails the source with the surfaced reason", async (t) => {
  const { result, failMessages, warnings } = await runDownloadPhase(t, {
    queueSlots: [],
    appendImpl: () => {
      throw new Error("SABnzbd rejected the NZB URL: Job already exists in history");
    },
    titles: ["The Lumineers - Brightside (2022) FLAC"],
  });

  assert.equal(warnings.length, 0);
  assert.equal(result.failed, true);
  assert.deepEqual(failMessages, [
    "SABnzbd rejected the NZB URL: Job already exists in history",
  ]);
});

test("non-duplicate append errors still warn and keep the existing behavior", async (t) => {
  const { result, warnings, debugs } = await runDownloadPhase(t, {
    queueSlots: [],
    appendImpl: () => {
      throw new Error("SABnzbd addurl failed: HTTP 500");
    },
    titles: [
      "The Lumineers - Brightside (2022) FLAC",
      "The Lumineers - Brightside (2022) MP3",
    ],
  });

  assert.equal(warnings.length, 1);
  const [category, message, details] = warnings[0].arguments;
  assert.equal(category, "slskd");
  assert.equal(message, "Usenet client append failed for release");
  assert.equal(details.error, "SABnzbd addurl failed: HTTP 500");
  assert.equal(
    debugs.some(
      (call) => call.arguments[1] === "Usenet client rejected duplicate release",
    ),
    false,
  );
  assert.equal(result.phase, "download");
  assert.equal(result.candidateIndex, 1);
  assert.equal(result.nzbId, null);
});

test("non-duplicate append rejection without a reason fails the source with the plain message", async (t) => {
  const { result, failMessages, warnings } = await runDownloadPhase(t, {
    queueSlots: [],
    appendImpl: () => {
      throw new Error("SABnzbd rejected the NZB URL");
    },
    titles: ["The Lumineers - Brightside (2022) FLAC"],
  });

  assert.equal(warnings.length, 1);
  assert.equal(result.failed, true);
  assert.deepEqual(failMessages, ["SABnzbd rejected the NZB URL"]);
});
