export const CANONICAL_HOLD_REASONS = Object.freeze({
  TREND: Object.freeze({
    reasonCode: "HOLD_TREND_STRUCTURE_INTACT",
    reason:
      "GIỮ LỆNH: Cấu trúc xu hướng M15 vẫn còn hiệu lực; chưa có điều kiện thoát lệnh.",
  }),

  SIDEWAY: Object.freeze({
    reasonCode: "HOLD_SIDEWAY_RANGE_VALID",
    reason:
      "GIỮ LỆNH: Biên sideway vẫn còn hiệu lực; tiếp tục giữ đến TP2 hoặc khi có điều kiện thoát.",
  }),

  RECOVERY_TP: Object.freeze({
    reasonCode: "HOLD_RECOVERY_TP_ACTIVE",
    reason:
      "GIỮ LỆNH: Recovery TP đang hoạt động; giữ toàn bộ vị thế đến Adaptive TP hoặc SL/BE.",
  }),
});

export function canonicalHoldReason(
  strategy,
  managedOrMode = null,
) {
  const normalizedStrategy =
    String(strategy ?? "")
      .trim()
      .toUpperCase();

  const dailyMode =
    typeof managedOrMode === "string"
      ? managedOrMode
      : managedOrMode?.dailyMode;

  if (
    String(dailyMode ?? "")
      .trim()
      .toUpperCase() ===
    "RECOVERY_TP"
  ) {
    return CANONICAL_HOLD_REASONS.RECOVERY_TP;
  }

  if (normalizedStrategy === "TREND") {
    return CANONICAL_HOLD_REASONS.TREND;
  }

  if (normalizedStrategy === "SIDEWAY") {
    return CANONICAL_HOLD_REASONS.SIDEWAY;
  }

  return null;
}
