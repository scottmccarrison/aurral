/**
 * Event loop lag monitor: tracks drift and warns when event loop is blocked.
 * Usage: const monitor = createLagMonitor({ checkMs, warnMs, now, onLag });
 *        monitor.tick() to call on each interval.
 */
export function createLagMonitor({ checkMs, warnMs, now = () => Date.now(), onLag }) {
  let expectedAt = now() + checkMs;

  return {
    tick() {
      const current = now();
      const lagMs = current - expectedAt;
      if (lagMs > warnMs) {
        onLag({ lagMs });
      }
      // Always reset to prevent drift accrual
      expectedAt = now() + checkMs;
    },
  };
}
