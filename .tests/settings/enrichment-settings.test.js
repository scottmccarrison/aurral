import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps }, { registerGeneral }, { defaultData }] =
  await setupIsolatedBackend(
    "enrichment-settings",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/routes/settings/handlers/general.js",
    "backend/config/constants.js",
  );

test.beforeEach(() => {
  resetDatabase(db);
  dbOps.invalidateSettingsCache();
  dbOps.updateSettings({ integrations: {}, onboardingComplete: true });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

// --- defaults applied on read ---------------------------------------------

test("GET defaults: no stored enrichment row returns all 5 defaults from constants.js", async () => {
  const { getSettings } = captureSettingsRoutes();
  const response = await getSettings();
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.enrichment, {
    embedCoverArt: true,
    sidecarCoverArt: true,
    repairSweepEnabled: true,
    repairFillMbid: true,
    repairBatchLimit: 200,
  });
});

test("enrichment is a top-level settings block, not nested under integrations", () => {
  const settings = defaultData.settings;
  assert.equal(settings.integrations.enrichment, undefined);
  assert.deepEqual(settings.enrichment, {
    embedCoverArt: true,
    sidecarCoverArt: true,
    repairSweepEnabled: true,
    repairFillMbid: true,
    repairBatchLimit: 200,
  });
});

test("partial updateSettings leaves every other key at its default (defaults-on-read proof)", () => {
  // A stored object missing keys must yield the defaults: `undefined` must NOT
  // disable a feature, or a partial write would silently kill the repair sweep.
  dbOps.updateSettings({ enrichment: { repairSweepEnabled: false } });
  assert.deepEqual(dbOps.getSettings().enrichment, {
    repairSweepEnabled: false,
    embedCoverArt: true,
    sidecarCoverArt: true,
    repairFillMbid: true,
    repairBatchLimit: 200,
  });

  dbOps.updateSettings({ enrichment: { embedCoverArt: false } });
  const after = dbOps.getSettings().enrichment;
  assert.equal(after.embedCoverArt, false);
  assert.equal(after.repairSweepEnabled, true, "previous partial write must not stick");
  assert.equal(after.sidecarCoverArt, true);
  assert.equal(after.repairFillMbid, true);
  assert.equal(after.repairBatchLimit, 200);
});

test("empty stored object yields all defaults, never undefined", () => {
  dbOps.updateSettings({ enrichment: {} });
  const enrichment = dbOps.getSettings().enrichment;
  for (const key of [
    "embedCoverArt",
    "sidecarCoverArt",
    "repairSweepEnabled",
    "repairFillMbid",
  ]) {
    assert.equal(enrichment[key], true, `${key} must default to true, not undefined`);
  }
  assert.equal(enrichment.repairBatchLimit, 200);
});

test("unknown keys round-trip through updateSettings", () => {
  dbOps.updateSettings({
    enrichment: { customFutureKey: 123, nested: { a: 1 }, repairBatchLimit: 50 },
  });
  const enrichment = dbOps.getSettings().enrichment;
  assert.equal(enrichment.customFutureKey, 123);
  assert.deepEqual(enrichment.nested, { a: 1 });
  assert.equal(enrichment.repairBatchLimit, 50);
});

// --- repairBatchLimit coercion --------------------------------------------

test("repairBatchLimit: 0, negative, null, empty string and NaN all fall back to 200", () => {
  for (const value of [0, -5, null, "", "banana", NaN, undefined, Infinity]) {
    dbOps.updateSettings({ enrichment: { repairBatchLimit: value } });
    assert.equal(
      dbOps.getSettings().enrichment.repairBatchLimit,
      200,
      `repairBatchLimit ${String(value)} should fall back to 200`,
    );
  }
});

test("repairBatchLimit: positive values are preserved and floored to an integer", () => {
  dbOps.updateSettings({ enrichment: { repairBatchLimit: 1 } });
  assert.equal(dbOps.getSettings().enrichment.repairBatchLimit, 1);

  dbOps.updateSettings({ enrichment: { repairBatchLimit: 5000 } });
  assert.equal(dbOps.getSettings().enrichment.repairBatchLimit, 5000);

  dbOps.updateSettings({ enrichment: { repairBatchLimit: 42.9 } });
  assert.equal(dbOps.getSettings().enrichment.repairBatchLimit, 42);

  dbOps.updateSettings({ enrichment: { repairBatchLimit: "75" } });
  assert.equal(dbOps.getSettings().enrichment.repairBatchLimit, 75);
});

test("enable flags coerce with !== false so only an explicit false disables", () => {
  dbOps.updateSettings({
    enrichment: {
      embedCoverArt: false,
      sidecarCoverArt: 0,
      repairSweepEnabled: "false",
      repairFillMbid: null,
    },
  });
  const enrichment = dbOps.getSettings().enrichment;
  assert.equal(enrichment.embedCoverArt, false, "explicit false disables");
  assert.equal(enrichment.sidecarCoverArt, true, "0 is not false");
  assert.equal(enrichment.repairSweepEnabled, true, 'the string "false" is not false');
  assert.equal(enrichment.repairFillMbid, true, "null is not false");
});

// --- HTTP surface ----------------------------------------------------------

test("route level: POST /api/settings with enrichment persists and GET returns values", async () => {
  const { postSettings, getSettings } = captureSettingsRoutes();
  const response = await postSettings({
    enrichment: {
      embedCoverArt: false,
      sidecarCoverArt: false,
      repairSweepEnabled: false,
      repairFillMbid: false,
      repairBatchLimit: 25,
    },
  });
  assert.equal(response.statusCode, 200);

  const saved = await getSettings();
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.body.enrichment, {
    embedCoverArt: false,
    sidecarCoverArt: false,
    repairSweepEnabled: false,
    repairFillMbid: false,
    repairBatchLimit: 25,
  });
});

test("route level: partial POST merges with current settings so kill switches survive", async () => {
  const { postSettings, getSettings } = captureSettingsRoutes();
  await postSettings({ enrichment: { repairBatchLimit: 40, repairFillMbid: false } });
  // Second call touches one key only; the route must merge, not replace.
  const response = await postSettings({ enrichment: { repairSweepEnabled: false } });
  assert.equal(response.statusCode, 200);

  const saved = await getSettings();
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.body.enrichment, {
    embedCoverArt: true,
    sidecarCoverArt: true,
    repairSweepEnabled: false,
    repairFillMbid: false,
    repairBatchLimit: 40,
  });
});

test("route level: POST without enrichment leaves the stored block untouched", async () => {
  const { postSettings, getSettings } = captureSettingsRoutes();
  await postSettings({ enrichment: { repairBatchLimit: 12 } });
  const response = await postSettings({ quality: "high" });
  assert.equal(response.statusCode, 200);

  const saved = await getSettings();
  assert.equal(saved.body.enrichment.repairBatchLimit, 12);
  assert.equal(saved.body.enrichment.repairSweepEnabled, true);
});

/**
 * Drives registerGeneral with a fake express router, mirroring
 * .tests/settings/matching-settings.test.js. `handlers.at(-1)` skips the auth
 * middleware so the handler under test runs directly.
 */
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
