import { noCache } from "../../../middleware/cache.js";
import { requireAuth } from "../../../middleware/requirePermission.js";
import {
  getLibraryMetadataGapCounts,
  listLibraryMetadataGaps,
} from "../../../services/libraryMediaStore.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const parseNonNegativeInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

/**
 * GET /api/library/metadata-gaps?limit=&offset=
 *
 * Read-only view of the same SQL gap predicate the metadata repair sweep works
 * from (backend/services/libraryMediaStore.js). No filesystem walk, no
 * mutation - safe to poll. Middleware mirrors the sibling canonical.js routes:
 * `requireAuth` (the global authMiddleware in server.js populates req.user) and
 * `noCache`, since the counts move every time the sweep runs.
 */
export function registerMetadataGaps(router) {
  router.get("/metadata-gaps", requireAuth, noCache, async (req, res) => {
    try {
      const limit = Math.min(
        MAX_LIMIT,
        Math.max(1, parseNonNegativeInt(req.query?.limit, DEFAULT_LIMIT) || DEFAULT_LIMIT),
      );
      const offset = parseNonNegativeInt(req.query?.offset, 0);

      res.json({
        counts: getLibraryMetadataGapCounts(),
        items: listLibraryMetadataGaps({ limit, offset }),
        limit,
        offset,
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to fetch metadata gaps",
        message: error.message,
      });
    }
  });
}

export { DEFAULT_LIMIT as METADATA_GAPS_DEFAULT_LIMIT, MAX_LIMIT as METADATA_GAPS_MAX_LIMIT };
