import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps }, { registerGeneral }] =
  await setupIsolatedBackend(
    "matching-settings",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/routes/settings/handlers/general.js",
  );

test.beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({ integrations: {}, onboardingComplete: true });
});

test.after(async () => {
  db.close();
  await cleanupIsolatedState(isolatedState);
});

test("GET defaults: no stored matching row returns all 7 defaults from constants.js", async () => {
  const { getSettings } = captureSettingsRoutes();
  const response = await getSettings();
  assert.equal(response.statusCode, 200);
  const matching = response.body.matching;
  assert.equal(matching.autoApproveDistance, 0.10);
  assert.equal(matching.autoDenyDistance, 0.50);
  assert.equal(matching.reviewTimeoutHours, 48);
  assert.equal(matching.reviewAction, "hold");
  assert.equal(matching.trackNumberMismatchTolerance, true);
  assert.equal(matching.albumVersionMatching, true);
  assert.equal(matching.requireExactAlbumMatch, false);
});

test("round-trip preserves unknown keys: updateSettings with custom key survives", async () => {
  const { postSettings, getSettings } = captureSettingsRoutes();
  const response = await postSettings({
    matching: {
      customFutureKey: 123,
      autoApproveDistance: 0.2,
    },
  });
  assert.equal(response.statusCode, 200);

  const saved = await getSettings();
  assert.equal(saved.statusCode, 200);
  const matching = saved.body.matching;
  assert.equal(matching.customFutureKey, 123);
  assert.equal(matching.autoApproveDistance, 0.2);
  assert.equal(matching.autoDenyDistance, 0.50);
  assert.equal(matching.reviewTimeoutHours, 48);
  assert.equal(matching.reviewAction, "hold");
  assert.equal(matching.trackNumberMismatchTolerance, true);
  assert.equal(matching.albumVersionMatching, true);
  assert.equal(matching.requireExactAlbumMatch, false);
});

test("clamps and validates: invalid values reset to defaults", async () => {
  const { postSettings, getSettings } = captureSettingsRoutes();
  const response = await postSettings({
    matching: {
      autoApproveDistance: 5,
      autoDenyDistance: -1,
      reviewTimeoutHours: 0,
      reviewAction: "banana",
      trackNumberMismatchTolerance: false,
      requireExactAlbumMatch: true,
    },
  });
  assert.equal(response.statusCode, 200);

  const saved = await getSettings();
  assert.equal(saved.statusCode, 200);
  const matching = saved.body.matching;
  assert.equal(matching.autoApproveDistance, 0.10, "autoApproveDistance: 5 should clamp to 0.10");
  assert.equal(matching.autoDenyDistance, 0.50, "autoDenyDistance: -1 should clamp to 0.50");
  assert.equal(matching.reviewTimeoutHours, 48, "reviewTimeoutHours: 0 should default to 48");
  assert.equal(matching.reviewAction, "hold", "reviewAction: banana should default to hold");
  assert.equal(matching.trackNumberMismatchTolerance, false, "trackNumberMismatchTolerance: false should be preserved");
  assert.equal(matching.albumVersionMatching, true, "albumVersionMatching: not provided should default to true");
  assert.equal(matching.requireExactAlbumMatch, true, "requireExactAlbumMatch: true should be preserved");
});

test("sanity check: autoApproveDistance > autoDenyDistance resets both to defaults", async () => {
  const { postSettings, getSettings } = captureSettingsRoutes();
  const response = await postSettings({
    matching: {
      autoApproveDistance: 0.8,
      autoDenyDistance: 0.2,
    },
  });
  assert.equal(response.statusCode, 200);

  const saved = await getSettings();
  assert.equal(saved.statusCode, 200);
  const matching = saved.body.matching;
  assert.equal(matching.autoApproveDistance, 0.10, "should reset to default when approve > deny");
  assert.equal(matching.autoDenyDistance, 0.50, "should reset to default when approve > deny");
});

test("partial update leaves other keys intact", async () => {
  const { postSettings, getSettings } = captureSettingsRoutes();
  // First, set all values
  await postSettings({
    matching: {
      autoApproveDistance: 0.15,
      autoDenyDistance: 0.45,
      reviewTimeoutHours: 72,
      reviewAction: "auto-deny",
      trackNumberMismatchTolerance: false,
      albumVersionMatching: false,
      requireExactAlbumMatch: true,
    },
  });

  // Then, update only one field
  const response = await postSettings({
    matching: {
      autoApproveDistance: 0.25,
    },
  });
  assert.equal(response.statusCode, 200);

  const saved = await getSettings();
  assert.equal(saved.statusCode, 200);
  const matching = saved.body.matching;
  assert.equal(matching.autoApproveDistance, 0.25, "updated field should change");
  assert.equal(matching.autoDenyDistance, 0.45, "other fields should remain");
  assert.equal(matching.reviewTimeoutHours, 72, "other fields should remain");
  assert.equal(matching.reviewAction, "auto-deny", "other fields should remain");
  assert.equal(matching.trackNumberMismatchTolerance, false, "other fields should remain");
  assert.equal(matching.albumVersionMatching, false, "other fields should remain");
  assert.equal(matching.requireExactAlbumMatch, true, "other fields should remain");
});

test("route level: POST /api/settings with matching persists and GET returns values", async () => {
  const { postSettings, getSettings } = captureSettingsRoutes();
  const response = await postSettings({
    matching: {
      autoApproveDistance: 0.35,
      autoDenyDistance: 0.65,
      reviewTimeoutHours: 96,
      reviewAction: "retry-next-candidate",
      trackNumberMismatchTolerance: false,
      albumVersionMatching: false,
      requireExactAlbumMatch: true,
    },
  });
  assert.equal(response.statusCode, 200);

  const saved = await getSettings();
  assert.equal(saved.statusCode, 200);
  const matching = saved.body.matching;
  assert.equal(matching.autoApproveDistance, 0.35);
  assert.equal(matching.autoDenyDistance, 0.65);
  assert.equal(matching.reviewTimeoutHours, 96);
  assert.equal(matching.reviewAction, "retry-next-candidate");
  assert.equal(matching.trackNumberMismatchTolerance, false);
  assert.equal(matching.albumVersionMatching, false);
  assert.equal(matching.requireExactAlbumMatch, true);
});

test("M1: null/empty string numeric fields coerce to defaults, not 0", async () => {
  const { postSettings, getSettings } = captureSettingsRoutes();
  const response = await postSettings({
    matching: {
      autoApproveDistance: null,
      autoDenyDistance: "",
      reviewTimeoutHours: null,
    },
  });
  assert.equal(response.statusCode, 200);

  const saved = await getSettings();
  assert.equal(saved.statusCode, 200);
  const matching = saved.body.matching;
  assert.equal(matching.autoApproveDistance, 0.10, "autoApproveDistance: null should default to 0.10, not coerce to 0");
  assert.equal(matching.autoDenyDistance, 0.50, "autoDenyDistance: empty string should default to 0.50, not coerce to 0");
  assert.equal(matching.reviewTimeoutHours, 48, "reviewTimeoutHours: null should default to 48, not coerce to 0");
});

function captureSettingsRoutes() {
  const routes = {};
  registerGeneral({
    get(path, ...handlers) {
      routes[`GET ${path}`] = handlers.at(-1);
    },
    post(path, ...handlers) {
      routes[`POST ${path}`] = handlers.at(-1);
    },
  });
  const makeResponse = () => {
    let state = { statusCode: 200, body: null };
    return {
      get statusCode() {
        return state.statusCode;
      },
      get body() {
        return state.body;
      },
      status(code) {
        state.statusCode = code;
        return this;
      },
      json(body) {
        state.body = body;
        return this;
      },
    };
  };
  const postSettings = async (body) => {
    const response = makeResponse();
    await routes["POST /"]({ body, user: { id: 1 } }, response);
    return response;
  };
  const getSettings = async () => {
    const response = makeResponse();
    await routes["GET /"]({}, response);
    return response;
  };
  return { postSettings, getSettings };
}
