import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createBackgroundProcessSupervisor } from "../backend/services/backgroundProcessSupervisor.js";
import {
  ISOLATED_WORKER_GROUPS,
  isQueueOwnedByGroup,
  shouldStartQueueHere,
} from "../backend/services/backgroundWorkerQueues.js";

test("only the owning process supervises isolated queues", () => {
  assert.deepEqual(ISOLATED_WORKER_GROUPS, [
    "library", "discovery-refresh", "discovery-playlist-build",
    "discovery-user-refresh", "maintenance", "inbox", "notifications",
    "play-events", "flow", "scheduler",
  ]);
  assert.equal(isQueueOwnedByGroup("library-scan"), false);
  assert.equal(isQueueOwnedByGroup("library-scan", "library"), true);
  assert.equal(isQueueOwnedByGroup("discovery-refresh", "library"), false);
  assert.equal(isQueueOwnedByGroup("discovery-refresh", "discovery-refresh"), true);
  assert.equal(isQueueOwnedByGroup("system-task-inbox", "inbox"), true);
  assert.equal(isQueueOwnedByGroup("_outbox:notifications", "notifications"), true);
  assert.equal(isQueueOwnedByGroup("_outbox:play-events", "play-events"), true);
  assert.equal(isQueueOwnedByGroup("notification-outbox", "notifications"), true);
  assert.equal(isQueueOwnedByGroup("system-task", "flow"), true);
  assert.equal(isQueueOwnedByGroup("weekly-flow-operation", "flow"), true);
  assert.equal(isQueueOwnedByGroup("slskd-pipeline", "flow"), true);
  assert.equal(isQueueOwnedByGroup("system-task"), false);
  assert.equal(isQueueOwnedByGroup("system-task", "library"), false);
  assert.equal(isQueueOwnedByGroup("playlist-mbid-enrichment", "flow"), true);
  const previousNodeEnv = process.env.NODE_ENV;
  const previousGroup = process.env.AURRAL_BACKGROUND_WORKER_GROUP;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.AURRAL_BACKGROUND_WORKER_GROUP;
    assert.equal(shouldStartQueueHere("library-scan"), false);
    assert.equal(shouldStartQueueHere("system-task"), false);
    process.env.AURRAL_BACKGROUND_WORKER_GROUP = "library";
    assert.equal(shouldStartQueueHere("library-scan"), true);
    assert.equal(shouldStartQueueHere("system-task"), false);
    assert.equal(shouldStartQueueHere("discovery-refresh"), false);
    process.env.AURRAL_BACKGROUND_WORKER_GROUP = "flow";
    assert.equal(shouldStartQueueHere("system-task"), true);
    assert.equal(shouldStartQueueHere("weekly-flow-operation"), true);
    assert.equal(shouldStartQueueHere("library-scan"), false);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousGroup === undefined) delete process.env.AURRAL_BACKGROUND_WORKER_GROUP;
    else process.env.AURRAL_BACKGROUND_WORKER_GROUP = previousGroup;
  }
});

test("supervisor starts each group, forwards messages, and stops without respawning", async () => {
  const launches = [];
  const messages = [];
  const fakeFork = (_entry, _args, options) => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.sent = [];
    child.send = (message) => {
      child.sent.push(message);
      if (message.type === "shutdown") {
        child.exitCode = 0;
        queueMicrotask(() => child.emit("exit", 0, null));
      }
    };
    child.kill = () => { throw new Error("graceful shutdown should suffice"); };
    launches.push({ child, options });
    return child;
  };
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["library", "discovery"],
    forkProcess: fakeFork,
    onMessage: (message, group) => messages.push({ message, group }),
  });

  assert.equal(supervisor.start(), true);
  assert.equal(supervisor.start(), false);
  assert.deepEqual(launches.map(({ options }) => options.env.AURRAL_BACKGROUND_WORKER_GROUP),
    ["library", "discovery"]);
  assert.deepEqual(supervisor.getGroups(), ["library", "discovery"]);
  launches[0].child.emit("message", { type: "websocket-broadcast", channel: "library" });
  assert.deepEqual(messages, [{ message: { type: "websocket-broadcast", channel: "library" }, group: "library" }]);
  launches[0].child.emit("message", {
    type: "heartbeat",
    workers: [{ name: "library-scan", running: true }],
  });
  assert.deepEqual(supervisor.getWorkerStatuses(), [{ name: "library-scan", running: true }]);

  assert.equal(supervisor.wake("discovery"), true);
  assert.deepEqual(launches[1].child.sent, [{ type: "queue-wake" }]);
  assert.equal(supervisor.wake("missing"), false);

  await supervisor.stop();
  assert.deepEqual(launches.map(({ child }) => child.sent),
    [[{ type: "shutdown" }], [{ type: "queue-wake" }, { type: "shutdown" }]]);
  assert.deepEqual(supervisor.getGroups(), []);
  assert.deepEqual(supervisor.getWorkerStatuses(), []);
});

test("supervisor restarts an unexpectedly exited worker", async () => {
  const children = [];
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["library"],
    logger: { warn() {}, error() {} },
    forkProcess: () => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.send = () => queueMicrotask(() => child.emit("exit", 0, null));
      child.kill = () => {};
      children.push(child);
      return child;
    },
  });
  try {
    supervisor.start();
    children[0].exitCode = 1;
    children[0].emit("close", 1, null);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(children.length, 2);
    assert.deepEqual(supervisor.getGroups(), ["library"]);
  } finally {
    await supervisor.stop();
  }
});

test("flow requests return replies and reject when their owner exits", async () => {
  const children = [];
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["flow"],
    logger: { warn() {}, error() {} },
    forkProcess: () => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.connected = true;
      child.sent = [];
      child.send = (message) => {
        child.sent.push(message);
        if (message.type === "shutdown") {
          child.exitCode = 0;
          queueMicrotask(() => child.emit("exit", 0, null));
        }
      };
      child.kill = () => {};
      children.push(child);
      return child;
    },
  });
  try {
    supervisor.start();
    const first = supervisor.request("flow", "start");
    const request = children[0].sent.at(-1);
    assert.equal(request.type, "flow-command");
    assert.equal(request.method, "start");
    children[0].emit("message", { type: "flow-response", requestId: request.requestId, result: true });
    assert.equal(await first, true);

    children[0].emit("message", {
      type: "heartbeat", workers: [], flowStatus: { running: true },
    });
    assert.deepEqual(supervisor.getFlowStatus(), { running: true });
    const pending = supervisor.request("flow", "waitForIdle");
    children[0].emit("exit", 1, null);
    await assert.rejects(pending, /exited before responding/);
    assert.equal(supervisor.getFlowStatus(), null);
  } finally {
    await supervisor.stop();
  }
});

test("flow restart waits for job recovery", async () => {
  const children = [];
  let finishRecovery;
  const recovery = new Promise((resolve) => { finishRecovery = resolve; });
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["flow"],
    logger: { warn() {}, error() {} },
    onExit: () => recovery,
    forkProcess: () => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.send = (message) => {
        if (message.type === "shutdown") {
          child.exitCode = 0;
          queueMicrotask(() => child.emit("exit", 0, null));
        }
      };
      child.kill = () => {};
      children.push(child);
      return child;
    },
  });
  try {
    supervisor.start();
    children[0].emit("exit", 1, null);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(children.length, 1);
    finishRecovery();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(children.length, 2);
  } finally {
    await supervisor.stop();
  }
});

test("only the worker with an overdue job is terminated", async () => {
  const children = new Map();
  const killed = [];
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["inbox", "maintenance"],
    jobTimeoutsMs: { inbox: 25, maintenance: 25 },
    unresponsiveMs: 1000,
    watchdogIntervalMs: 10,
    logger: { warn() {}, error() {} },
    forkProcess: (_entry, _args, options) => {
      const group = options.env.AURRAL_BACKGROUND_WORKER_GROUP;
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.send = (message) => {
        if (message.type === "shutdown") {
          child.exitCode = 0;
          queueMicrotask(() => child.emit("exit", 0, null));
        }
      };
      child.kill = () => { killed.push(group); };
      children.set(group, child);
      return child;
    },
  });
  try {
    supervisor.start();
    children.get("inbox").emit("message", { type: "job-started", jobId: 42 });
    await new Promise((resolve) => setTimeout(resolve, 65));
    assert.deepEqual(killed, ["inbox"]);
    assert.deepEqual(supervisor.getGroups(), ["inbox", "maintenance"]);
  } finally {
    await supervisor.stop();
  }
});

test("startup grace: child that never messages is NOT killed before spawnGraceMs", async () => {
  const children = [];
  const killed = [];
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["library"],
    unresponsiveMs: 50,
    spawnGraceMs: 300,
    watchdogIntervalMs: 20,
    logger: { warn() {}, error() {} },
    forkProcess: () => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.send = (message) => {
        if (message.type === "shutdown") {
          child.exitCode = 0;
          queueMicrotask(() => child.emit("exit", 0, null));
        }
      };
      child.kill = () => { killed.push("library"); };
      children.push(child);
      return child;
    },
  });
  try {
    supervisor.start();
    // Wait for unresponsiveMs to pass (50ms) - should NOT kill because still in grace period (300ms)
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(killed, [], "should not kill during grace period");
    // Now wait for grace to expire - wait until well past 300ms total
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(killed, ["library"], "should kill after grace expires");
  } finally {
    await supervisor.stop();
  }
});

test("startup grace: child IS killed after spawnGraceMs with no message", async () => {
  const children = [];
  const killed = [];
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["library"],
    unresponsiveMs: 120000,
    spawnGraceMs: 150,
    watchdogIntervalMs: 20,
    logger: { warn() {}, error() {} },
    forkProcess: () => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.send = () => {};
      child.kill = () => { killed.push("library"); };
      children.push(child);
      return child;
    },
  });
  try {
    supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 230));
    assert.deepEqual(killed, ["library"], "should kill after spawnGraceMs");
  } finally {
    await supervisor.stop();
  }
});

test("startup grace: after first message, normal unresponsiveMs rule applies", async () => {
  const children = [];
  const killed = [];
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["library"],
    unresponsiveMs: 100,
    spawnGraceMs: 300,
    watchdogIntervalMs: 20,
    logger: { warn() {}, error() {} },
    forkProcess: () => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.send = () => {};
      child.kill = () => { killed.push("library"); };
      children.push(child);
      return child;
    },
  });
  try {
    supervisor.start();
    // Send one message to exit grace period (within first 50ms of startup)
    await new Promise((resolve) => setTimeout(resolve, 30));
    children[0].emit("message", { type: "heartbeat", workers: [] });
    // Now wait for unresponsiveMs (100ms) to pass from the message timestamp
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.deepEqual(killed, ["library"], "should use unresponsiveMs, not spawnGraceMs");
  } finally {
    await supervisor.stop();
  }
});

test("startup grace: after restart, new child gets fresh grace and is killed after grace from second spawn", async () => {
  const children = [];
  const killed = [];
  const spawnTimes = [];
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["library"],
    unresponsiveMs: 50,
    spawnGraceMs: 300,
    watchdogIntervalMs: 20,
    logger: { warn() {}, error() {} },
    forkProcess: () => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      spawnTimes.push(Date.now());
      child.send = (message) => {
        if (message.type === "shutdown") {
          child.exitCode = 0;
          queueMicrotask(() => child.emit("exit", 0, null));
        }
      };
      child.kill = () => {
        killed.push("kill");
        child.exitCode = 137;
        queueMicrotask(() => child.emit("exit", 137, "SIGKILL"));
      };
      children.push(child);
      return child;
    },
  });
  try {
    supervisor.start();
    const firstSpawnTime = spawnTimes[0];
    
    // Wait for grace to expire on first child (300ms)
    await new Promise((resolve) => setTimeout(resolve, 380));
    assert.equal(killed.length, 1, "first child should be killed after grace");
    
    // Wait for restart (default 1s base delay)
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(children.length, 2, "should have forked twice (original + restart)");
    const secondSpawnTime = spawnTimes[1];
    
    // Second child should also get grace; verify timing from second spawn
    killed.length = 0;
    
    // Wait 100ms from second spawn (still in grace, should not kill)
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(killed, [], "second child should not be killed yet in fresh grace");
    
    // Wait until well past grace from second spawn (~300ms)
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(killed, ["kill"], "should kill after grace expires from second spawn");
    
    // Verify second kill happened ~300ms after second spawn
    const killTime = spawnTimes[1] + 300;
    assert.ok(Date.now() >= killTime, "kill should occur after grace from second spawn");
  } finally {
    await supervisor.stop();
  }
});

test("startup grace: fresh grace resets on fork failure + restart", async () => {
  const children = [];
  const killed = [];
  let forkAttempt = 0;
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["library"],
    unresponsiveMs: 50,
    spawnGraceMs: 300,
    watchdogIntervalMs: 20,
    logger: { warn() {}, error() {} },
    forkProcess: () => {
      forkAttempt += 1;
      if (forkAttempt === 1) {
        // First fork: throw to simulate failure
        throw new Error("First fork failed");
      }
      // Second fork succeeds: never-messaged child gets fresh grace
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.send = (message) => {
        if (message.type === "shutdown") {
          child.exitCode = 0;
          queueMicrotask(() => child.emit("exit", 0, null));
        }
      };
      child.kill = () => {
        killed.push("kill");
        child.exitCode = 137;
        queueMicrotask(() => child.emit("exit", 137, "SIGKILL"));
      };
      children.push(child);
      return child;
    },
  });
  try {
    supervisor.start();
    // First fork fails, wait for restart delay (base 1s)
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(children.length, 1, "should have spawned after first fork failure");
    
    // Wait 100ms (still in grace, should not kill)
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(killed, [], "should not kill fresh child in grace");
    
    // Wait until well past grace (300ms from spawn)
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(killed, ["kill"], "should kill after grace expires from second spawn");
  } finally {
    await supervisor.stop();
  }
});
