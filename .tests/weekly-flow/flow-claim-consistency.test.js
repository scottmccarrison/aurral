/*
 * Cross-process flow claim consistency (issue #13).
 *
 * The dedup registries (activeReleases/failureMemory) and the tracker's
 * slskdDispatched marks only exist in the isolated FLOW worker process, while
 * tracker WRITES are never RPC'd — so a web-process transition used to "clear"
 * claim state in an empty local copy and leave the owner's real claim behind.
 * A wedged claim makes markActive() refuse the release forever, which re-enqueues
 * the job every 30s, and a missing forget-half leaves failure memory suppressing
 * a release that already landed.
 *
 * These tests cover the five layers of the fix:
 *   1. downloadDedupService.releaseJobState / reconcileClaims primitives
 *   2. the "releaseJobState" / "reconcileDedupClaims" flow commands (real forked
 *      flow worker child, driven through the background process supervisor)
 *   3. the tracker choke point that routes every claim-clearing transition
 *      through the owner
 *   4. reconcileJobState() healing wedged jobs
 *   5. the awaited release in the deny/approve routes, and its ordering
 *
 * The RPC is observed through the configureFlowOwnerClient({ request }) seam —
 * never through ESM module mocks — and the non-owner branch is reached by
 * toggling NODE_ENV, because isFlowOwnerProcess() is true under NODE_ENV=test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps },
  dedupService,
  trackerModule,
  ownerClient,
  workerModule,
  routesModule,
  playlistManagerModule,
  flowConfigModule,
  supervisorModule,
  honkerDbModule,
  systemTaskModule,
] = await setupIsolatedBackend(
  "flow-claim-consistency",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/downloadDedupService.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/weeklyFlow/weeklyFlowOwnerClient.js",
  "backend/services/weeklyFlow/weeklyFlowWorker.js",
  "backend/routes/weeklyFlow/handlers/jobs.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistManager.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
  "backend/services/backgroundProcessSupervisor.js",
  "backend/services/honkerDb.js",
  "backend/services/systemTaskWorker.js",
);

const { downloadTracker, WeeklyFlowDownloadTracker } = trackerModule;
const { weeklyFlowWorker } = workerModule;
const { registerJobs } = routesModule;
const { playlistManager } = playlistManagerModule;
const { flowPlaylistConfig } = flowConfigModule;
const { createBackgroundProcessSupervisor } = supervisorModule;
const {
  getReleaseKeys,
  getStats,
  markActive,
  markFailed,
  reconcileClaims,
  releaseJobState,
  resetAll,
} = dedupService;
const { configureFlowOwnerClient, isFlowOwnerProcess } = ownerClient;

const MINUTE_MS = 60 * 1000;
const STALE_MS = 10 * MINUTE_MS;
const TRACK = {
  artistName: "Claim Artist",
  trackName: "Claim Song",
  albumName: "Claim Album",
  albumMbid: "claim-album-mbid",
};
// getReleaseKeys() precedence: releaseGuid -> albumMbid -> trackMbid -> "artist|album".
const TRACK_KEYS = ["claim-album-mbid", "claim artist|claim album"];
const OTHER_TRACK = {
  artistName: "Other Artist",
  trackName: "Other Song",
  albumName: "Other Album",
  albumMbid: "other-album-mbid",
};
const OTHER_KEYS = ["other-album-mbid", "other artist|other album"];

test.beforeEach(async () => {
  await resetDatabase(db);
  downloadTracker.clearAll();
  // The dedup registries are module-global and outlive a single test.
  resetAll();
  // resetDatabase() clears the settings rows behind the cache's back.
  dbOps.invalidateSettingsCache();
});

test.after(async () => {
  resetFlowOwnerClient();
  db.close();
  await cleanupIsolatedState(isolatedState);
});

/* ------------------------------------------------------------------ helpers */

/** Observe flow-owner RPCs through the documented injection seam. */
function installFakeFlowOwner({ events = null, failWith = null } = {}) {
  const calls = [];
  configureFlowOwnerClient({
    request: async (method, args, options) => {
      calls.push({ method, args, options });
      events?.push(`release:${method}`);
      if (failWith) throw failWith;
      return { released: 0 };
    },
    getStatus: () => null,
  });
  return calls;
}

function resetFlowOwnerClient() {
  configureFlowOwnerClient({ request: null, getStatus: null });
}

/**
 * Run `fn` as the WEB process. isFlowOwnerProcess() is true whenever
 * NODE_ENV=test, so the RPC branch is otherwise unreachable in tests.
 */
async function asWebProcess(fn) {
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    testServer: process.env.AURRAL_TEST_SERVER,
    group: process.env.AURRAL_BACKGROUND_WORKER_GROUP,
  };
  process.env.NODE_ENV = "production";
  delete process.env.AURRAL_TEST_SERVER;
  delete process.env.AURRAL_BACKGROUND_WORKER_GROUP;
  try {
    assert.equal(isFlowOwnerProcess(), false, "expected the web (non-owner) process");
    return await fn();
  } finally {
    for (const [key, value] of Object.entries({
      NODE_ENV: previous.nodeEnv,
      AURRAL_TEST_SERVER: previous.testServer,
      AURRAL_BACKGROUND_WORKER_GROUP: previous.group,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function seedJob(tracker = downloadTracker, track = TRACK, playlistId = "claim-playlist") {
  const jobId = tracker.addJob(track, playlistId);
  assert.ok(jobId, "job must be created");
  return jobId;
}

/** Plant a claim exactly the way the slskd orchestrator does. */
function claimFor(jobId, keys = TRACK_KEYS, source = "slskd") {
  const claim = markActive(keys, source, jobId);
  assert.equal(claim.claimed, true, `claim must succeed: ${claim.reason}`);
  return claim;
}

function activeKeysFor(jobId) {
  return getStats().activeReleases
    .filter((entry) => entry.jobId === jobId)
    .map((entry) => entry.releaseKey)
    .sort();
}

function failureKeys() {
  return getStats().failureMemory.map((entry) => entry.key).sort();
}

/** Every release RPC fired by `mutate`, observed from the web process. */
async function captureReleaseRpc(mutate) {
  const calls = installFakeFlowOwner();
  try {
    await asWebProcess(async () => {
      await mutate();
    });
  } finally {
    resetFlowOwnerClient();
  }
  return calls.filter((call) => call.method === "releaseJobState");
}

function releaseArgs(calls, index = 0) {
  const call = calls[index];
  assert.ok(call, `expected a releaseJobState RPC at index ${index}`);
  return { ids: call.args[0], options: call.args[1], timeoutMs: call.options?.timeoutMs };
}

/* ------------------------------------------- Layer 1: the release primitive */

test("releaseJobState drops only the target job's claims", () => {
  const targetId = "job-target";
  const otherId = "job-other";
  claimFor(targetId, TRACK_KEYS);
  claimFor(otherId, OTHER_KEYS);
  assert.deepEqual(activeKeysFor(targetId), [...TRACK_KEYS].sort());

  const result = releaseJobState(targetId);

  assert.deepEqual(result, { released: 2 }, "both identities of the job are released");
  assert.deepEqual(activeKeysFor(targetId), []);
  assert.deepEqual(activeKeysFor(otherId), [...OTHER_KEYS].sort(), "other jobs keep their claims");
});

test("releaseJobState accepts a batch and leaves failure memory alone by default", () => {
  const firstId = "job-first";
  const secondId = "job-second";
  claimFor(firstId, [TRACK_KEYS[0]]);
  claimFor(secondId, [OTHER_KEYS[0]]);
  // A different source than the one holding the claim: markFailed() drops the
  // active claim only when it belongs to the failing source.
  markFailed(TRACK_KEYS[0], "usenet", new Error("provider exploded"));

  const result = releaseJobState([firstId, secondId]);

  assert.deepEqual(result, { released: 2 });
  assert.deepEqual(getStats().activeReleases, []);
  assert.deepEqual(
    failureKeys(),
    [`${TRACK_KEYS[0]}|usenet`],
    "releasing a job must not forget why its source failed",
  );
});

test("releaseJobState forgets failures only for the keys it is given", () => {
  const jobId = "job-forget";
  markFailed(TRACK_KEYS[0], "slskd", new Error("provider exploded"));
  markFailed(TRACK_KEYS[1], "usenet", new Error("provider exploded"));
  markFailed(OTHER_KEYS[0], "slskd", new Error("provider exploded"));
  assert.equal(failureKeys().length, 3);

  releaseJobState(jobId, { forgetFailures: true, releaseKeys: [TRACK_KEYS[0]] });

  assert.deepEqual(
    failureKeys(),
    [`${OTHER_KEYS[0]}|slskd`, `${TRACK_KEYS[1]}|usenet`].sort(),
    "only the supplied identity is forgotten",
  );

  // forgetFailures without keys must never widen into a blanket wipe.
  releaseJobState(jobId, { forgetFailures: true });
  assert.equal(failureKeys().length, 2);

  releaseJobState(jobId, { forgetFailures: true, releaseKeys: [TRACK_KEYS[1]] });
  assert.deepEqual(failureKeys(), [`${OTHER_KEYS[0]}|slskd`]);
});

test("releaseJobState is idempotent and tolerates garbage input", () => {
  const jobId = "job-idempotent";
  claimFor(jobId, [TRACK_KEYS[0]]);

  assert.deepEqual(releaseJobState(jobId), { released: 1 });
  assert.deepEqual(releaseJobState(jobId), { released: 0 }, "second release is a no-op");

  const garbage = [
    undefined,
    null,
    "",
    "   ",
    [],
    [null, undefined, "", {}],
    [{}, [[[]]]],
    42,
    Symbol.iterator,
  ];
  for (const input of garbage) {
    let result;
    assert.doesNotThrow(() => {
      result = releaseJobState(input, { forgetFailures: true, releaseKeys: [null, 7, ""] });
    }, `releaseJobState must tolerate ${String(input)}`);
    assert.deepEqual(result, { released: 0 });
  }
  // Garbage options must not throw either.
  for (const options of [null, "garbage", 42, [], { releaseKeys: "nope" }]) {
    assert.doesNotThrow(() => releaseJobState(jobId, options));
  }
  assert.deepEqual(getStats().activeReleases, [], "no claim was resurrected by garbage input");
});

/* ------------------------- Layer 4: reconcileClaims / reconcileJobState heal */

test("reconcileClaims drops claims whose owner is missing or terminal", () => {
  const statuses = new Map([
    ["job-done", "done"],
    ["job-failed", "failed"],
    ["job-cancelled", "cancelled"],
    ["job-blocked", "blocked"],
  ]);
  for (const [jobId, status] of statuses) {
    claimFor(jobId, [`key-${status}`], "slskd");
  }
  claimFor("job-ghost", ["key-ghost"], "slskd");
  assert.equal(getStats().activeReleases.length, 5);

  // Young claims: only the owner's state can condemn them here.
  const result = reconcileClaims((jobId) => statuses.get(jobId) ?? null, {
    now: Date.now(),
    staleMs: STALE_MS,
  });

  assert.deepEqual(result, { reaped: 5 });
  assert.deepEqual(getStats().activeReleases, []);
});

test("reconcileClaims heals a wedged pending job and keeps live handoffs", () => {
  const statuses = new Map([
    ["job-wedged", "pending"],
    ["job-handoff", "pending"],
    ["job-downloading", "downloading"],
    ["job-cancel-requested", "cancel_requested"],
  ]);
  const seedAll = () => {
    for (const [jobId, status] of statuses) {
      claimFor(jobId, [`key-${status}-${jobId}`], "slskd");
    }
    assert.equal(getStats().activeReleases.length, 4);
  };
  const readStatus = (jobId) => statuses.get(jobId) ?? null;

  // Young claims: a pending owner mid-handoff is legitimate, so nothing is
  // reaped even though two owners are not actively downloading.
  seedAll();
  const young = reconcileClaims(readStatus, { now: Date.now() + MINUTE_MS, staleMs: STALE_MS });
  assert.deepEqual(young, { reaped: 0 }, "nothing is stale after one minute");
  assert.equal(getStats().activeReleases.length, 4);

  // The same claims eleven minutes later. `pending` + old is exactly the
  // wedged-job residue this heals: the transition that should have released
  // the claim never reached this process, so markActive() would refuse the
  // release forever and the job would be re-enqueued every 30s.
  // `cancel_requested` is now kept at any age (it always terminates in `cancelled`).
  resetAll();
  seedAll();
  const old = reconcileClaims(readStatus, {
    now: Date.now() + STALE_MS + MINUTE_MS,
    staleMs: STALE_MS,
  });
  assert.deepEqual(old, { reaped: 2 }, "stale pending owners are reaped; cancel_requested is kept");
  assert.deepEqual(
    getStats().activeReleases.map((entry) => entry.jobId).sort(),
    ["job-cancel-requested", "job-downloading"].sort(),
    "downloading and cancel_requested owners keep their claims regardless of age",
  );

  // Idempotent: a second pass finds nothing left to reap.
  assert.deepEqual(
    reconcileClaims(readStatus, { now: Date.now() + STALE_MS + MINUTE_MS, staleMs: STALE_MS }),
    { reaped: 0 },
  );

  // A custom staleMs is honoured: the same claim is young again under a
  // one-hour budget.
  resetAll();
  seedAll();
  assert.deepEqual(
    reconcileClaims(readStatus, {
      now: Date.now() + STALE_MS + MINUTE_MS,
      staleMs: 60 * MINUTE_MS,
    }),
    { reaped: 0 },
  );
});

test("reconcileClaims reaps downloading claims older than 6h (orphaned backstop)", () => {
  const statuses = new Map([
    ["job-downloading-young", "downloading"],
    ["job-downloading-old", "downloading"],
  ]);
  const readStatus = (jobId) => statuses.get(jobId) ?? null;

  // Young downloading claim (30 min): kept unconditionally.
  claimFor("job-downloading-young", ["key-young"], "slskd");
  const youngResult = reconcileClaims(readStatus, {
    now: Date.now() + 30 * MINUTE_MS,
    staleMs: STALE_MS,
  });
  assert.deepEqual(youngResult, { reaped: 0 }, "young downloading claim is kept");
  assert.equal(getStats().activeReleases.length, 1);

  // Old downloading claim (7 hours): reaped as orphaned.
  resetAll();
  claimFor("job-downloading-old", ["key-old"], "slskd");
  const oldResult = reconcileClaims(readStatus, {
    now: Date.now() + 7 * 60 * MINUTE_MS,
    staleMs: STALE_MS,
  });
  assert.deepEqual(oldResult, { reaped: 1 }, "downloading claim older than 6h is reaped");
  assert.deepEqual(getStats().activeReleases, []);
});

test("reconcileClaims keeps cancel_requested claims at any age until they become cancelled", () => {
  const statuses = new Map([
    ["job-cancel-requested", "cancel_requested"],
    ["job-cancelled", "cancelled"],
  ]);
  const readStatus = (jobId) => statuses.get(jobId) ?? null;

  // cancel_requested claim 2 hours old: kept (not age-reaped).
  claimFor("job-cancel-requested", ["key-cancel-requested"], "slskd");
  const keepResult = reconcileClaims(readStatus, {
    now: Date.now() + 2 * 60 * MINUTE_MS,
    staleMs: STALE_MS,
  });
  assert.deepEqual(keepResult, { reaped: 0 }, "cancel_requested claim is kept at any age");
  assert.equal(getStats().activeReleases.length, 1);

  // Once the job transitions to cancelled (terminal), the claim is reaped.
  statuses.set("job-cancel-requested", "cancelled");
  const reapResult = reconcileClaims(readStatus, {
    now: Date.now() + 2 * 60 * MINUTE_MS,
    staleMs: STALE_MS,
  });
  assert.deepEqual(reapResult, { reaped: 1 }, "cancelled claim is reaped");
  assert.deepEqual(getStats().activeReleases, []);
});

test("reconcileClaims keeps claims when the status read fails and sanitizes options", () => {
   claimFor("job-unknown", ["key-unknown"], "slskd");

  const throwing = reconcileClaims(() => {
    throw new Error("database is locked");
  }, { now: Date.now() + 60 * MINUTE_MS, staleMs: STALE_MS });
  assert.deepEqual(throwing, { reaped: 0 }, "a failed read must never reap");
  assert.equal(getStats().activeReleases.length, 1);

  // Garbage options fall back to the defaults instead of throwing.
  assert.deepEqual(reconcileClaims(null, "garbage"), { reaped: 0 });
  assert.deepEqual(reconcileClaims((jobId) => (jobId === "job-unknown" ? null : "pending"), {
    now: "not-a-number",
    staleMs: -5,
  }), { reaped: 1 }, "a missing owner is reaped with default options");
});

test("reconcileJobState prunes dispatch marks and claims together", () => {
  const tracker = new WeeklyFlowDownloadTracker();
  const doneId = seedJob(tracker, TRACK, "reconcile-playlist");
  const liveId = seedJob(tracker, OTHER_TRACK, "reconcile-playlist");
  tracker.setDownloading(doneId);
  tracker.setDone(doneId, "/library/Claim Song.flac", "Claim Album");
  tracker.setDownloading(liveId);

  // Plant the residue the reconcile exists to heal: state that outlived the
  // transition because the release never reached this process.
  tracker.markSlskdDispatched(doneId);
  tracker.markSlskdDispatched("ghost-job");
  tracker.markSlskdDispatched(liveId);
  claimFor(doneId, TRACK_KEYS);
  claimFor(liveId, OTHER_KEYS);
  assert.equal(tracker.isSlskdDispatched(liveId), true);

  const result = tracker.reconcileJobState({ now: Date.now(), staleMs: STALE_MS });

  assert.deepEqual(result, {
    claimsReaped: 2,
    dispatchedCleared: 2,
  }, "the done job's two identities plus its dispatch mark, plus the ghost mark");
  assert.equal(tracker.slskdDispatched.has(doneId), false);
  assert.equal(tracker.slskdDispatched.has("ghost-job"), false);
  assert.equal(tracker.isSlskdDispatched(liveId), true, "an in-flight job keeps its mark");
  assert.deepEqual(activeKeysFor(liveId), [...OTHER_KEYS].sort());

  assert.deepEqual(
    tracker.reconcileJobState({ now: Date.now(), staleMs: STALE_MS }),
    { claimsReaped: 0, dispatchedCleared: 0 },
    "reconcile is idempotent",
  );
});

test("the reconcile is registered as a flow-owned scheduled task and dispatches", async () => {
  const task = honkerDbModule.SCHEDULED_SYSTEM_TASKS.find(
    (entry) => entry.name === "dedup-claim-reconcile",
  );
  assert.ok(task, "dedup-claim-reconcile must be a scheduled system task");
  // "system-task" is the flow-owned queue: the reconcile prunes the dedup
  // registries and dispatch marks, which only exist in the flow process.
  assert.equal(task.queue, "system-task");
  assert.equal(task.schedule, "@every 15m");
  assert.deepEqual(task.payload, { kind: "dedup-claim-reconcile" });
  assert.equal(
    honkerDbModule.getSystemTaskQueueName(task.payload.kind),
    task.queue,
    "the kind must resolve to the queue the task is registered on",
  );

  // Plant the wedge on the singleton the task will reconcile: a claim and a
  // dispatch mark that outlived their job's completion.
  const jobId = seedJob(downloadTracker, TRACK, "reconcile-task");
  downloadTracker.setDownloading(jobId);
  downloadTracker.setDone(jobId, "/library/Claim Song.flac", "Claim Album");
  claimFor(jobId, TRACK_KEYS);
  downloadTracker.markSlskdDispatched(jobId);

  const result = await systemTaskModule.processSystemTask({ kind: "dedup-claim-reconcile" });

  assert.deepEqual(result, { claimsReaped: 2, dispatchedCleared: 1 });
  assert.deepEqual(activeKeysFor(jobId), [], "the terminal owner's claim is gone");
  assert.equal(downloadTracker.slskdDispatched.has(jobId), false);
});

test("pruneOrphanedJobState heals claim state as its last step", () => {
  const jobId = seedJob(downloadTracker, TRACK, "prune-reconcile");
  downloadTracker.setFailed(jobId, "provider exploded");
  claimFor(jobId, TRACK_KEYS);
  downloadTracker.markSlskdDispatched("ghost-job");

  weeklyFlowWorker.pruneOrphanedJobState();

  assert.deepEqual(activeKeysFor(jobId), [], "the failed owner's claim is reaped");
  assert.equal(
    downloadTracker.slskdDispatched.has("ghost-job"),
    false,
    "a dispatch mark with no job is pruned",
  );
});

/* ------------------- Layer 2: the flow commands in a real flow worker child */

test("the flow worker answers releaseJobState and reconcileDedupClaims", async () => {
  let markReady;
  const ready = new Promise((resolve) => { markReady = resolve; });
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["flow"],
    logger: { warn() {}, error() {} },
    onMessage(message) {
      if (message?.type === "ready") markReady();
    },
    forkProcess: (entry, args, options) => fork(entry, args, {
      ...options,
      env: {
        ...options.env,
        // Keeps the child from starting real queue workers while still making
        // it the flow owner, which is the process that owns these maps.
        AURRAL_TEST_SERVER: "1",
        NODE_ENV: "test",
      },
    }),
  });
  try {
    supervisor.start();
    // The startup timer must be cleared: a live timer would hold the test
    // process open for its whole duration after the child is gone.
    let readyTimer = null;
    try {
      await Promise.race([
        ready,
        new Promise((_resolve, reject) => {
          readyTimer = setTimeout(
            () => reject(new Error("flow worker child did not become ready")),
            60_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(readyTimer);
    }

    // Registered commands reach the tracker and return its serializable result.
    assert.deepEqual(
      await supervisor.request("flow", "releaseJobState", [["job-not-here"], {}]),
      { released: 0 },
    );
    assert.deepEqual(
      await supervisor.request("flow", "reconcileDedupClaims", []),
      { claimsReaped: 0, dispatchedCleared: 0 },
    );
    // A single jobId string is accepted as well as an array.
    assert.deepEqual(
      await supervisor.request("flow", "releaseJobState", ["job-not-here"]),
      { released: 0 },
    );

    // Unusable ids are rejected rather than silently released.
    await assert.rejects(
      supervisor.request("flow", "releaseJobState", [[123], {}]),
      /job ids must be strings/,
    );
    await assert.rejects(
      supervisor.request("flow", "releaseJobState", [[]]),
      /non-empty array of job ids/,
    );
    await assert.rejects(
      supervisor.request("flow", "releaseJobState", [["  "], {}]),
      /must not be empty/,
    );
    await assert.rejects(
      supervisor.request("flow", "releaseJobState", [null, {}]),
      /job id or a non-empty array/,
    );

    // Garbage options are sanitized down to a safe shape, never rejected and
    // never widened into a blanket failure-memory wipe.
    assert.deepEqual(
      await supervisor.request("flow", "releaseJobState", [["job-not-here"], "garbage"]),
      { released: 0 },
    );
    assert.deepEqual(
      await supervisor.request("flow", "releaseJobState", [
        ["job-not-here"],
        { forgetFailures: "yes", releaseKeys: [null, 42, "  key  "], dropEverything: true },
      ]),
      { released: 0 },
    );
    assert.deepEqual(
      await supervisor.request("flow", "reconcileDedupClaims", [{ now: "nope", staleMs: -1 }]),
      { claimsReaped: 0, dispatchedCleared: 0 },
    );

    // Contrast: an unregistered command is refused, which is what proves the
    // two commands above are wired into FLOW_COMMANDS.
    await assert.rejects(
      supervisor.request("flow", "releaseJobStateTypo", []),
      /Unsupported flow worker command/,
    );
  } finally {
    await supervisor.stop();
  }
});

/* ------------------------- Layer 3: every choke point releases cross-process */

test("single-job transitions release their claim in the flow owner", async () => {
  const tracker = new WeeklyFlowDownloadTracker();
  const transitions = [
    {
      name: "setPending",
      seed: (id) => tracker.setDownloading(id),
      run: (id) => tracker.setPending(id, "retry later"),
    },
    {
      name: "setFailed",
      seed: (id) => tracker.setDownloading(id),
      run: (id) => tracker.setFailed(id, "provider exploded"),
    },
    {
      name: "setCancelled",
      seed: (id) => tracker.setDownloading(id),
      run: (id) => tracker.setCancelled(id),
    },
    {
      name: "setBlocked",
      seed: (id) => tracker.setDownloading(id),
      run: (id) => tracker.setBlocked(id, "blocked-duration-mismatch"),
    },
    {
      name: "removeJob",
      seed: () => {},
      run: (id) => tracker.removeJob(id),
    },
  ];

  for (const transition of transitions) {
    const jobId = seedJob(tracker, TRACK, "choke-playlist");
    transition.seed(jobId);
    const calls = await captureReleaseRpc(() => transition.run(jobId));
    assert.equal(calls.length, 1, `${transition.name} must fire exactly one release`);
    const { ids, options, timeoutMs } = releaseArgs(calls);
    assert.deepEqual(ids, [jobId], `${transition.name} releases the transitioned job`);
    assert.deepEqual(options, {}, `${transition.name} must never forget failures`);
    assert.equal(timeoutMs, 5000, "the release must not hang a synchronous mutation");
  }
});

test("setDone releases with setDone semantics: forget failures for captured keys", async () => {
  const tracker = new WeeklyFlowDownloadTracker();
  const jobId = seedJob(tracker, TRACK, "choke-playlist");
  tracker.setDownloading(jobId);

  const calls = await captureReleaseRpc(() =>
    tracker.setDone(jobId, "/library/Claim Song.flac", "Renamed Album"));

  assert.equal(calls.length, 1);
  const { ids, options } = releaseArgs(calls);
  assert.deepEqual(ids, [jobId]);
  assert.equal(options.forgetFailures, true, "a landed release forgets its failures");
  assert.deepEqual(
    options.releaseKeys,
    TRACK_KEYS,
    "keys are captured before the album rename, so they match the claim",
  );
});

test("batch transitions release once with the whole id array", async () => {
  const tracker = new WeeklyFlowDownloadTracker();

  // _deleteJobsWhere (through clearCompleted): ONE RPC for the batch.
  const doneA = seedJob(tracker, TRACK, "batch-playlist");
  const doneB = seedJob(tracker, OTHER_TRACK, "batch-playlist");
  const pending = seedJob(tracker, { ...TRACK, trackName: "Pending Song" }, "batch-playlist");
  tracker.setDone(doneA, "/library/A.flac", "Claim Album");
  tracker.setDone(doneB, "/library/B.flac", "Other Album");
  const deleteCalls = await captureReleaseRpc(() => tracker.clearCompleted());
  assert.equal(deleteCalls.length, 1, "clearCompleted must not RPC once per deleted job");
  assert.deepEqual(releaseArgs(deleteCalls).ids.sort(), [doneA, doneB].sort());
  assert.deepEqual(releaseArgs(deleteCalls).options, {});
  assert.equal(tracker.getJob(pending) !== null, true, "the pending job survives");

  // failActiveJobsForPlaylist: ONE RPC for the playlist's active jobs.
  const activeA = seedJob(tracker, TRACK, "fail-playlist");
  const activeB = seedJob(tracker, OTHER_TRACK, "fail-playlist");
  const elsewhere = seedJob(tracker, TRACK, "other-playlist");
  tracker.setDownloading(activeB);
  const failCalls = await captureReleaseRpc(() =>
    tracker.failActiveJobsForPlaylist("fail-playlist", "Retry cycle paused"));
  assert.equal(failCalls.length, 1);
  assert.deepEqual(releaseArgs(failCalls).ids.sort(), [activeA, activeB].sort());
  assert.deepEqual(releaseArgs(failCalls).options, {});
  assert.equal(tracker.getJob(elsewhere)?.status, "pending", "other playlists are untouched");

  // resetDownloadingToPending: ONE RPC for every job put back in the queue.
  const resetA = seedJob(tracker, TRACK, "reset-playlist");
  const resetB = seedJob(tracker, OTHER_TRACK, "reset-playlist");
  tracker.setDownloading(resetA);
  tracker.setDownloading(resetB);
  const resetCalls = await captureReleaseRpc(() => tracker.resetDownloadingToPending());
  assert.equal(resetCalls.length, 1);
  assert.deepEqual(releaseArgs(resetCalls).ids.sort(), [resetA, resetB].sort());
  assert.deepEqual(releaseArgs(resetCalls).options, {});

  // clearAll: ONE RPC with every id, captured before the map is emptied.
   const allIds = tracker.getAll().map((job) => job.id);
   assert.ok(allIds.length >= 3);
   const clearCalls = await captureReleaseRpc(() => tracker.clearAll());
   assert.equal(clearCalls.length, 1);
   assert.deepEqual(releaseArgs(clearCalls).ids.sort(), [...allIds].sort());
   assert.deepEqual(releaseArgs(clearCalls).options, {});
 });

 test("resetDownloadingToPending batches mixed cancel_requested and downloading jobs into one RPC", async () => {
   const tracker = new WeeklyFlowDownloadTracker();
   // Create 2 cancel_requested jobs and 3 downloading jobs
   const cancelA = seedJob(tracker, TRACK, "mixed-playlist");
   const cancelB = seedJob(tracker, OTHER_TRACK, "mixed-playlist");
   const downloadA = seedJob(tracker, { ...TRACK, trackName: "Download A" }, "mixed-playlist");
   const downloadB = seedJob(tracker, { ...TRACK, trackName: "Download B" }, "mixed-playlist");
   const downloadC = seedJob(tracker, { ...OTHER_TRACK, trackName: "Download C" }, "mixed-playlist");

   // Set up the states
   tracker.setDownloading(cancelA);
   tracker.setCancelRequested(cancelA);
   tracker.setDownloading(cancelB);
   tracker.setCancelRequested(cancelB);
   tracker.setDownloading(downloadA);
   tracker.setDownloading(downloadB);
   tracker.setDownloading(downloadC);

   // Capture the RPC call
   const calls = await captureReleaseRpc(() => tracker.resetDownloadingToPending());

   // Should fire exactly ONE RPC with all 5 ids
   assert.equal(calls.length, 1, "resetDownloadingToPending must fire exactly one RPC for mixed states");
   const { ids, options } = releaseArgs(calls);
   assert.deepEqual(ids.sort(), [cancelA, cancelB, downloadA, downloadB, downloadC].sort(),
     "the RPC must include all 5 job ids (2 cancel_requested + 3 downloading)");
   assert.deepEqual(options, {}, "no special options for the batch release");
 });

 test("a transition with nothing to release still reports no RPC for empty batches", async () => {
  const tracker = new WeeklyFlowDownloadTracker();
  const calls = await captureReleaseRpc(() => tracker.failActiveJobsForPlaylist("no-such-playlist"));
  assert.deepEqual(calls, [], "an empty batch must not spend an RPC");
});

test("in the flow owner the same transitions clean up locally without any RPC", () => {
   assert.equal(isFlowOwnerProcess(), true, "NODE_ENV=test is the flow owner");
   const calls = installFakeFlowOwner();
   try {
     const jobId = seedJob(downloadTracker, TRACK, "owner-playlist");
     claimFor(jobId, TRACK_KEYS);
     // A different source than the claim holder, so the claim survives until
     // setDone releases it (markFailed drops a claim only for its own source).
     markFailed(TRACK_KEYS[0], "usenet", new Error("provider exploded"));
     downloadTracker.markSlskdDispatched(jobId);
     downloadTracker.setDownloading(jobId);
     assert.deepEqual(activeKeysFor(jobId), [...TRACK_KEYS].sort());
     assert.equal(failureKeys().length, 1);

     downloadTracker.setDone(jobId, "/library/Claim Song.flac", "Claim Album");

     assert.deepEqual(calls, [], "the owner never RPCs itself");
     assert.deepEqual(activeKeysFor(jobId), [], "the claim is gone locally");
     assert.deepEqual(failureKeys(), [], "setDone forgot the release's failures locally");
     assert.equal(downloadTracker.slskdDispatched.has(jobId), false, "dispatch mark cleared");
     assert.equal(downloadTracker.getJob(jobId)?.status, "done");
   } finally {
     resetFlowOwnerClient();
   }
 });

 test("in the flow owner resetDownloadingToPending cleans up all mixed-state jobs locally", () => {
   assert.equal(isFlowOwnerProcess(), true, "NODE_ENV=test is the flow owner");
   const calls = installFakeFlowOwner();
   try {
     // Create 2 cancel_requested jobs and 3 downloading jobs
     const cancelA = seedJob(downloadTracker, TRACK, "owner-mixed-playlist");
     const cancelB = seedJob(downloadTracker, OTHER_TRACK, "owner-mixed-playlist");
     const downloadA = seedJob(downloadTracker, { ...TRACK, trackName: "Download A" }, "owner-mixed-playlist");
     const downloadB = seedJob(downloadTracker, { ...TRACK, trackName: "Download B" }, "owner-mixed-playlist");
     const downloadC = seedJob(downloadTracker, { ...OTHER_TRACK, trackName: "Download C" }, "owner-mixed-playlist");

     // Plant claims for all 5 jobs
     claimFor(cancelA, TRACK_KEYS);
     claimFor(cancelB, OTHER_KEYS);
     claimFor(downloadA, [`key-downloadA`]);
     claimFor(downloadB, [`key-downloadB`]);
     claimFor(downloadC, [`key-downloadC`]);

     // Set up the states
     downloadTracker.setDownloading(cancelA);
     downloadTracker.setCancelRequested(cancelA);
     downloadTracker.setDownloading(cancelB);
     downloadTracker.setCancelRequested(cancelB);
     downloadTracker.setDownloading(downloadA);
     downloadTracker.setDownloading(downloadB);
     downloadTracker.setDownloading(downloadC);

     // Verify all claims are active before reset
     assert.equal(getStats().activeReleases.length, 7, "all 7 claim identities are active");

     downloadTracker.resetDownloadingToPending();

     // Owner never RPCs itself
     assert.deepEqual(calls, [], "the owner never RPCs itself");
     // All claims are released locally
     assert.deepEqual(getStats().activeReleases, [], "all claims are released locally");
     // All jobs are properly transitioned
     assert.equal(downloadTracker.getJob(cancelA)?.status, "cancelled");
     assert.equal(downloadTracker.getJob(cancelB)?.status, "cancelled");
     assert.equal(downloadTracker.getJob(downloadA)?.status, "pending");
     assert.equal(downloadTracker.getJob(downloadB)?.status, "pending");
     assert.equal(downloadTracker.getJob(downloadC)?.status, "pending");
   } finally {
     resetFlowOwnerClient();
   }
 });

 test("a failed cross-process release is swallowed, never thrown at the caller", async () => {
  const tracker = new WeeklyFlowDownloadTracker();
  const jobId = seedJob(tracker, TRACK, "flow-down-playlist");
  const calls = installFakeFlowOwner({ failWith: new Error("Flow worker is not ready") });
  try {
    await asWebProcess(() => {
      // A synchronous mutation must not reject or throw when the owner is down;
      // reconcileJobState() is the safety net that reaps the stranded claim.
      assert.doesNotThrow(() => tracker.setFailed(jobId, "provider exploded"));
    });
  } finally {
    resetFlowOwnerClient();
  }
  assert.equal(calls.length, 1);
  assert.equal(tracker.getJob(jobId)?.status, "failed", "the local transition still happened");
  // Let the fire-and-forget rejection settle so it cannot surface as an
  // unhandled rejection in a later test.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

/* --------------------------- Layer 5: the deny/approve routes release + order */

/** Capture the route handlers without standing up an HTTP server. */
function captureRouteHandlers() {
  const routes = new Map();
  const register = (verb) => (routePath, ...handlers) => {
    routes.set(`${verb} ${routePath}`, handlers[handlers.length - 1]);
  };
  registerJobs({
    get: register("GET"),
    post: register("POST"),
    put: register("PUT"),
    delete: register("DELETE"),
    patch: register("PATCH"),
    use: () => {},
  });
  return routes;
}

function fakeResponse(events) {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      events.push("response");
      return res;
    },
  };
  return res;
}

/** Stub the worker side effects the routes trigger after a decision. */
function stubWorkerSideEffects(events) {
  const original = {
    wake: weeklyFlowWorker.wake,
    checkPlaylistComplete: weeklyFlowWorker.checkPlaylistComplete,
  };
  const wakeCalls = [];
  weeklyFlowWorker.wake = (...args) => {
    wakeCalls.push(args);
    events.push("wake");
  };
  weeklyFlowWorker.checkPlaylistComplete = async () => {};
  return {
    wakeCalls,
    restore() {
      weeklyFlowWorker.wake = original.wake;
      weeklyFlowWorker.checkPlaylistComplete = original.checkPlaylistComplete;
    },
  };
}

async function seedBlockedJobForReview({ playlistId, track = TRACK, stagingPath }) {
  flowPlaylistConfig.createSharedPlaylist({
    // Shared playlist names must be unique, so the id doubles as the name.
    id: playlistId,
    name: playlistId,
    tracks: [{ artistName: track.artistName, trackName: track.trackName }],
  });
  const jobId = seedJob(downloadTracker, track, playlistId);
  downloadTracker.updateDownloadMetadata(jobId, {
    downloadSource: "slskd",
    remoteUsername: "claim-user",
    remoteFilename: "claim-file.flac",
  });
  downloadTracker.setBlocked(jobId, "blocked-duration-mismatch", stagingPath);
  return jobId;
}

// The approve route commits into the managed playlist library; the Navidrome
// client is stubbed exactly like the approved-import-path test does.
playlistManager.navidromeDestination.client = {
  isConfigured: () => true,
  async ensureWeeklyFlowLibrary() {},
  async getPlaylists() { return []; },
  async getPlaylistTrackPaths() { return []; },
  async findSong() { return { id: "claim-song" }; },
  async createPlaylist(name) { return { id: name, name }; },
  async updatePlaylist() {},
  async deletePlaylist() {},
  async scanLibrary() {},
};

const routes = captureRouteHandlers();
const denyRoute = routes.get("POST /jobs/:jobId/deny");
const approveRoute = routes.get("POST /jobs/:jobId/approve");

test("deny releases the claim before waking the worker and before responding", async () => {
  assert.ok(denyRoute, "the deny route must be registered");
  const jobId = await seedBlockedJobForReview({
    playlistId: "deny-ordering",
    stagingPath: path.join(isolatedState.baseDir, "deny-staging.flac"),
  });
  const events = [];
  const calls = installFakeFlowOwner({ events });
  const worker = stubWorkerSideEffects(events);
  let res;
  try {
    await asWebProcess(async () => {
      res = fakeResponse(events);
      await denyRoute({ params: { jobId }, body: {}, user: { role: "admin" } }, res);
    });
  } finally {
    worker.restore();
    resetFlowOwnerClient();
  }

  // setPending's choke point fires first (unawaited), then the route's awaited
  // release, then the wake, then the response. Releasing after the wake would
  // let the flow re-claim first and then drop that fresh legitimate claim.
  assert.deepEqual(events, [
    "release:releaseJobState",
    "release:releaseJobState",
    "wake",
    "response",
  ]);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true });
  assert.equal(worker.wakeCalls.length, 1);
  const releaseCalls = calls.filter((call) => call.method === "releaseJobState");
  assert.equal(releaseCalls.length, 2);
  for (const call of releaseCalls) {
    assert.deepEqual(call.args[0], [jobId]);
    assert.deepEqual(call.args[1], {}, "deny never forgets recorded failures");
    assert.equal(call.options.timeoutMs, 5000);
  }
});

test("approve releases with setDone semantics after the commit and before responding", async () => {
  assert.ok(approveRoute, "the approve route must be registered");
  const playlistId = "approve-ordering";
  const stagingPath = path.join(isolatedState.baseDir, "review", "Claim Song.flac");
  await fs.mkdir(path.dirname(stagingPath), { recursive: true });
  await fs.writeFile(stagingPath, "reviewed audio");
  const jobId = await seedBlockedJobForReview({ playlistId, stagingPath });
  const events = [];
  const calls = installFakeFlowOwner({ events });
  const worker = stubWorkerSideEffects(events);
  let res;
  try {
    await asWebProcess(async () => {
      res = fakeResponse(events);
      await approveRoute({ params: { jobId }, body: {}, user: { role: "admin" } }, res);
    });
  } finally {
    worker.restore();
    resetFlowOwnerClient();
  }

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  // The setDone choke point releases before the nested wake inside
  // finalizePipelineJobSuccess; the route's awaited release is the idempotent
  // double-cover that guarantees the release landed before the response.
  assert.deepEqual(events, [
    "release:releaseJobState",
    "wake",
    "release:releaseJobState",
    "response",
  ]);
  const releaseCalls = calls.filter((call) => call.method === "releaseJobState");
  assert.equal(releaseCalls.length, 2);
  for (const call of releaseCalls) {
    assert.deepEqual(call.args[0], [jobId]);
    assert.equal(call.args[1].forgetFailures, true, "approve uses setDone semantics");
    assert.deepEqual(call.args[1].releaseKeys, TRACK_KEYS);
  }
  assert.equal(events.at(-1), "response");
});

test("deny and approve still succeed when the flow worker is down", async () => {
  const denyJobId = await seedBlockedJobForReview({
    playlistId: "deny-flow-down",
    stagingPath: path.join(isolatedState.baseDir, "deny-down.flac"),
  });
  const events = [];
  installFakeFlowOwner({ events, failWith: new Error("Flow worker is not ready") });
  const worker = stubWorkerSideEffects(events);
  let denyRes;
  try {
    await asWebProcess(async () => {
      denyRes = fakeResponse(events);
      await denyRoute({ params: { jobId: denyJobId }, body: {}, user: { role: "admin" } }, denyRes);
    });
  } finally {
    worker.restore();
    resetFlowOwnerClient();
  }
  assert.equal(denyRes.statusCode, 200, JSON.stringify(denyRes.body));
  assert.deepEqual(denyRes.body, { success: true });
  assert.deepEqual(events, [
    "release:releaseJobState",
    "release:releaseJobState",
    "wake",
    "response",
  ], "a dead owner must not change the route's behaviour or ordering");

  const playlistId = "approve-flow-down";
  const stagingPath = path.join(isolatedState.baseDir, "review-down", "Claim Song.flac");
  await fs.mkdir(path.dirname(stagingPath), { recursive: true });
  await fs.writeFile(stagingPath, "reviewed audio");
  const approveJobId = await seedBlockedJobForReview({ playlistId, stagingPath });
  const approveEvents = [];
  installFakeFlowOwner({ events: approveEvents, failWith: new Error("Flow worker request timed out") });
  const approveWorker = stubWorkerSideEffects(approveEvents);
  let approveRes;
  try {
    await asWebProcess(async () => {
      approveRes = fakeResponse(approveEvents);
      await approveRoute(
        { params: { jobId: approveJobId }, body: {}, user: { role: "admin" } },
        approveRes,
      );
    });
  } finally {
    approveWorker.restore();
    resetFlowOwnerClient();
  }
  assert.equal(approveRes.statusCode, 200, JSON.stringify(approveRes.body));
  assert.equal(approveRes.body.success, true);
  assert.equal(
    downloadTracker.getJob(approveJobId)?.status,
    "done",
    "the import still committed even though the release could not be delivered",
  );
});
