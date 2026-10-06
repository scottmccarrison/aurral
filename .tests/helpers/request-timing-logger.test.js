import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createRequestTimingLogger } from "../../backend/middleware/requestTimingLogger.js";

function sendRequest({
  path = "/api/test",
  baseUrl = "",
  route = "/test",
  status = 200,
  durationMs = 100,
  method = "GET",
}) {
  const events = [];
  const res = new EventEmitter();
  res.statusCode = status;
  const req = {
    method,
    baseUrl,
    route: route ? { path: route } : undefined,
    path,
  };

  // Mock Date.now to control duration
  const originalDateNow = Date.now;
  let callCount = 0;
  Date.now = () => {
    callCount++;
    if (callCount === 1) return 1000; // start time
    return 1000 + durationMs; // end time
  };

  try {
    createRequestTimingLogger({
      info: (...args) => events.push(["info", ...args]),
      debug: (...args) => events.push(["debug", ...args]),
      warn: (...args) => events.push(["warn", ...args]),
      error: (...args) => events.push(["error", ...args]),
    })(req, res, () => {});

    res.emit("finish");
    return events;
  } finally {
    Date.now = originalDateNow;
  }
}

test("/api requests log Request completed at info level", () => {
  const events = sendRequest({
    path: "/api/test",
    baseUrl: "/api",
    route: "/test",
    status: 200,
    durationMs: 100,
    method: "GET",
  });
  assert.equal(events.length, 1);
  assert.equal(events[0][0], "info");
  assert.equal(events[0][1], "http");
  assert.equal(events[0][2], "Request completed");
  assert.deepEqual(events[0][3], {
    method: "GET",
    endpoint: "/api/test",
    status: 200,
    durationMs: 100,
  });
});

test("/rest requests log Request completed at debug level", () => {
  const events = sendRequest({
    path: "/rest/ping",
    baseUrl: "/rest",
    route: "/ping",
    status: 200,
    durationMs: 50,
    method: "GET",
  });
  assert.equal(events.length, 1);
  assert.equal(events[0][0], "debug");
  assert.equal(events[0][1], "http");
  assert.equal(events[0][2], "Request completed");
  assert.deepEqual(events[0][3], {
    method: "GET",
    endpoint: "/rest/ping",
    status: 200,
    durationMs: 50,
  });
});

test("static/non-API paths are not logged", () => {
  const events = sendRequest({
    path: "/index.html",
    baseUrl: "",
    route: undefined,
    status: 200,
    durationMs: 10,
    method: "GET",
  });
  assert.equal(events.length, 0);
});

test("slow /api requests (>1000ms, status 200) emit Slow request warning", () => {
  const events = sendRequest({
    path: "/api/slow",
    baseUrl: "/api",
    route: "/slow",
    status: 200,
    durationMs: 1500,
    method: "POST",
  });
  assert.equal(events.length, 2);
  // First event: Request completed at info
  assert.equal(events[0][0], "info");
  assert.equal(events[0][2], "Request completed");
  // Second event: Slow request warning
  assert.equal(events[1][0], "warn");
  assert.equal(events[1][1], "http");
  assert.equal(events[1][2], "Slow request");
  assert.deepEqual(events[1][3], {
    method: "POST",
    endpoint: "/api/slow",
    status: 200,
    durationMs: 1500,
  });
});

test("slow requests with 5xx status do not emit Slow request warning", () => {
  const events = sendRequest({
    path: "/api/error",
    baseUrl: "/api",
    route: "/error",
    status: 500,
    durationMs: 2000,
    method: "GET",
  });
  assert.equal(events.length, 1);
  assert.equal(events[0][0], "info");
  assert.equal(events[0][2], "Request completed");
  // No slow warning for 5xx
});

test("client abort (close without finish) logs exactly once", () => {
  const events = [];
  const res = new EventEmitter();
  res.statusCode = 200;
  const req = {
    method: "GET",
    baseUrl: "/api",
    route: { path: "/test" },
    path: "/api/test",
  };

  const originalDateNow = Date.now;
  let callCount = 0;
  Date.now = () => {
    callCount++;
    if (callCount === 1) return 1000;
    return 1100;
  };

  try {
    createRequestTimingLogger({
      info: (...args) => events.push(["info", ...args]),
      debug: (...args) => events.push(["debug", ...args]),
      warn: (...args) => events.push(["warn", ...args]),
      error: (...args) => events.push(["error", ...args]),
    })(req, res, () => {});

    // Emit close without finish
    res.emit("close");
    // Then emit finish (should not log again)
    res.emit("finish");
    assert.equal(events.length, 1);
    assert.equal(events[0][2], "Request completed");
  } finally {
    Date.now = originalDateNow;
  }
});

test("endpoint uses route pattern when req.route.path exists, falls back to req.path", () => {
  // With route
  const events1 = sendRequest({
    path: "/api/playlists/123/sync",
    baseUrl: "/api/playlists",
    route: "/:id/sync",
    status: 200,
    durationMs: 50,
    method: "POST",
  });
  assert.equal(events1[0][3].endpoint, "/api/playlists/:id/sync");

  // Without route (fallback to path)
  const events2 = sendRequest({
    path: "/api/fallback/test",
    baseUrl: "",
    route: undefined,
    status: 200,
    durationMs: 50,
    method: "GET",
  });
  assert.equal(events2.length, 0); // non-API path, so not logged
});

test("slow /rest requests also emit Slow request warning", () => {
  const events = sendRequest({
    path: "/rest/slow",
    baseUrl: "/rest",
    route: "/slow",
    status: 200,
    durationMs: 1200,
    method: "GET",
  });
  assert.equal(events.length, 2);
  assert.equal(events[0][0], "debug");
  assert.equal(events[0][2], "Request completed");
  assert.equal(events[1][0], "warn");
  assert.equal(events[1][2], "Slow request");
});
