import assert from "node:assert/strict";
import { test } from "node:test";
import { createLagMonitor } from "../backend/services/eventLoopLagMonitor.js";

test("lag monitor: tick arriving 31s late emits one warn with lagMs ≈ 31000", () => {
  const warnCalls = [];
  const now = () => currentTime;
  let currentTime = 1000;
  const monitor = createLagMonitor({
    checkMs: 5000,
    warnMs: 30000,
    now,
    onLag: ({ lagMs }) => {
      warnCalls.push(lagMs);
    },
  });

  // First tick at expected time
  currentTime = 1000;
  monitor.tick();
  assert.deepEqual(warnCalls, [], "no lag on first tick");

  // Second tick 31s late (expected at 6000, actual at 37000)
  currentTime = 37000;
  monitor.tick();
  assert.equal(warnCalls.length, 1, "should emit one warn");
  assert.equal(warnCalls[0], 31000, "lagMs should be ≈ 31000");
});

test("lag monitor: tick arriving 6s late (below threshold) emits nothing", () => {
  const warnCalls = [];
  const now = () => currentTime;
  let currentTime = 1000;
  const monitor = createLagMonitor({
    checkMs: 5000,
    warnMs: 30000,
    now,
    onLag: ({ lagMs }) => {
      warnCalls.push(lagMs);
    },
  });

  // First tick
  currentTime = 1000;
  monitor.tick();

  // Second tick 6s late (expected at 6000, actual at 12000)
  currentTime = 12000;
  monitor.tick();
  assert.deepEqual(warnCalls, [], "should not warn for 6s lag (below 30s threshold)");
});

test("lag monitor: drift does not accrue across ticks", () => {
  const warnCalls = [];
  const now = () => currentTime;
  let currentTime = 0;
  const monitor = createLagMonitor({
    checkMs: 10,
    warnMs: 50,
    now,
    onLag: ({ lagMs }) => {
      warnCalls.push(lagMs);
    },
  });

  // Tick 1: at t=0, expectedAt becomes 10
  currentTime = 0;
  monitor.tick();

  // Tick 2: at t=35. lagMs = 35 - 10 = 25, then expectedAt becomes 45
  currentTime = 35;
  monitor.tick();
  assert.deepEqual(warnCalls, [], "tick 2: no lag (only 25ms late, below 50ms threshold)");

  // Tick 3: at t=65. lagMs = 65 - 45 = 20, then expectedAt becomes 75
  // This verifies the expectedAt was reset to 45, not accumulated
  currentTime = 65;
  monitor.tick();
  assert.deepEqual(warnCalls, [], "tick 3: drift did not accrue (20ms lag, below threshold)");

  // Tick 4: at t=130. lagMs = 130 - 75 = 55ms, which exceeds 50ms threshold
  currentTime = 130;
  monitor.tick();
  assert.equal(warnCalls.length, 1, "tick 4: should warn on significant delay");
  assert.equal(warnCalls[0], 55, "lagMs should be 55 (not accumulated from previous ticks)");
});

test("lag monitor: multiple lags emit multiple warns", () => {
  const warnCalls = [];
  const now = () => currentTime;
  let currentTime = 1000;
  const monitor = createLagMonitor({
    checkMs: 5,
    warnMs: 20,
    now,
    onLag: ({ lagMs }) => {
      warnCalls.push(lagMs);
    },
  });

  // Tick 1
  currentTime = 1000;
  monitor.tick();

  // Tick 2: 25ms late
  currentTime = 1030;
  monitor.tick();
  assert.equal(warnCalls.length, 1);

  // Tick 3: 30ms late (measured from new expectedAt)
  currentTime = 1065;
  monitor.tick();
  assert.equal(warnCalls.length, 2);
});

test("lag monitor: errors in onLag callback are swallowed and do not propagate", () => {
  const now = () => currentTime;
  let currentTime = 1000;
  let throwingCallCount = 0;
  
  const monitor = createLagMonitor({
    checkMs: 5000,
    warnMs: 30000,
    now,
    onLag: ({ lagMs }) => {
      throwingCallCount += 1;
      throw new Error("Callback error should be swallowed");
    },
  });

  // First tick
  currentTime = 1000;
  monitor.tick();

  // Second tick with lag that exceeds threshold
  currentTime = 37000; // 31s late
  
  // This should not throw; error should be swallowed
  assert.doesNotThrow(() => {
    monitor.tick();
  });

  // Verify the callback was attempted (to confirm onLag was called)
  assert.equal(throwingCallCount, 1, "onLag should be called once");
  
  // Third tick should work normally (expectedAt was reset despite error)
  currentTime = 42000;
  throwingCallCount = 0;
  assert.doesNotThrow(() => {
    monitor.tick();
  });
  // Even with no lag, tick should complete without issues
  assert.equal(throwingCallCount, 0, "no lag on tick 3, so onLag not called");
});
