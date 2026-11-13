const TRANSIENT_MT5_READ_TIMEOUT =
  /^MT5 bridge GET \S+ \| timeout=\d+ms \| attempts=1$/;
const MT5_CYCLE_ERROR = /^MT5 bridge\b/;

export const DEFAULT_TRANSIENT_MT5_READ_ALERT_THRESHOLD = 3;
export const DEFAULT_TRANSIENT_MT5_READ_ALERT_WINDOW_MS = 60_000;

export function isMt5CycleErrorEvent(event) {
  const type = String(event?.type ?? "");
  if (type !== "CYCLE_ERROR") return false;

  const message = String(
    event?.message ??
      event?.reason ??
      "",
  ).trim();

  return MT5_CYCLE_ERROR.test(message);
}

export function isTransientMt5ReadTimeoutEvent(event) {
  const type = String(event?.type ?? "");
  if (type !== "CYCLE_ERROR") return false;

  const message = String(
    event?.message ??
      event?.reason ??
      "",
  ).trim();

  return TRANSIENT_MT5_READ_TIMEOUT.test(message);
}

export function evaluateTransientSystemAlertDebounce({
  event,
  current,
  nowMs = Date.now(),
  threshold = DEFAULT_TRANSIENT_MT5_READ_ALERT_THRESHOLD,
  windowMs = DEFAULT_TRANSIENT_MT5_READ_ALERT_WINDOW_MS,
}) {
  if (!isTransientMt5ReadTimeoutEvent(event)) {
    return {
      matched: false,
      suppress: false,
      count: 0,
      next: null,
    };
  }

  const safeNow = Number(nowMs);
  const normalizedNow =
    Number.isFinite(safeNow) && safeNow > 0
      ? safeNow
      : Date.now();
  const normalizedThreshold =
    Number.isFinite(Number(threshold))
      ? Math.max(2, Math.trunc(Number(threshold)))
      : DEFAULT_TRANSIENT_MT5_READ_ALERT_THRESHOLD;
  const normalizedWindowMs =
    Number.isFinite(Number(windowMs))
      ? Math.max(15_000, Math.trunc(Number(windowMs)))
      : DEFAULT_TRANSIENT_MT5_READ_ALERT_WINDOW_MS;

  const previousLastSeen = Number(current?.pendingLastSeenAtMs);
  const previousCount = Number(current?.pendingCount);
  const sameKind =
    String(current?.pendingKind ?? "") ===
    "MT5_READ_TIMEOUT";

  const withinWindow =
    sameKind &&
    Number.isFinite(previousLastSeen) &&
    previousLastSeen > 0 &&
    normalizedNow >= previousLastSeen &&
    normalizedNow - previousLastSeen <= normalizedWindowMs;

  const count =
    withinWindow &&
    Number.isFinite(previousCount) &&
    previousCount > 0
      ? Math.trunc(previousCount) + 1
      : 1;

  const timestamp = new Date(normalizedNow).toISOString();
  const message = String(
    event?.message ??
      event?.reason ??
      event?.type ??
      "",
  );

  return {
    matched: true,
    suppress: count < normalizedThreshold,
    count,
    next: {
      active: false,
      type: "CYCLE_ERROR",
      message,
      pendingKind: "MT5_READ_TIMEOUT",
      pendingCount: count,
      pendingStartedAtMs:
        withinWindow &&
        Number.isFinite(Number(current?.pendingStartedAtMs))
          ? Number(current.pendingStartedAtMs)
          : normalizedNow,
      pendingLastSeenAtMs: normalizedNow,
      lastSeenAt: timestamp,
      lastSeenAtMs: normalizedNow,
    },
  };
}
