import { logger } from "../services/logger.js";

export function createRequestTimingLogger(log = logger) {
  return (req, res, next) => {
    const start = Date.now();
    let logged = false;

    const logTiming = () => {
      try {
        if (logged) return;
        logged = true;

        const route = req.route?.path;
        const endpoint = typeof route === "string"
          ? `${req.baseUrl || ""}${route}`
          : req.path;

        // Only log /api, /api/*, /rest, and /rest/* requests
        if (endpoint !== "/api" && !endpoint?.startsWith("/api/") && endpoint !== "/rest" && !endpoint?.startsWith("/rest/")) return;

        const durationMs = Date.now() - start;
        const method = req.method;
        const status = res.statusCode;

        // Log based on route type
        if (endpoint === "/api" || endpoint.startsWith("/api/")) {
          log.info("http", "Request completed", { method, endpoint, status, durationMs });
        } else if (endpoint === "/rest" || endpoint.startsWith("/rest/")) {
          log.debug("http", "Request completed", { method, endpoint, status, durationMs });
        }

        // Warn if slow and not a 5xx error
        if (durationMs > 1000 && status < 500) {
          log.warn("http", "Slow request", { method, endpoint, status, durationMs });
        }
      } catch {
        // Swallow errors: logging must never affect request handling
      }
    };

    res.on("finish", logTiming);
    res.on("close", logTiming);

    next();
  };
}
