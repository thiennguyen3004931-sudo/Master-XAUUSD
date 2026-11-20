/**
 * Read-only source-level disclosure of V6's order volume policy.
 *
 * No broker API access, trading commands, or modification of existing settings.
 * This is NOT proof of the source/commit deployed on the Windows MT5 host.
 *
 * Guarantees: UI/API must NEVER claim Auto Lot is active while the broker
 * gateway still executes FIXED_LOT and the Auto Lot risk policy awaits LIVE
 * owner approval.
 */
export function getV6ExecutionSizingDisclosure({
  fixedLot,
  configVerified,
  requestedSizingMode = "FIXED_LOT",
} = {}) {
  const configuredLot = configVerified === true &&
    typeof fixedLot === "number" &&
    Number.isFinite(fixedLot) &&
    fixedLot > 0
    ? fixedLot
    : null;

  const normalizedRequested = requestedSizingMode === "AUTO_RISK_PERCENT" ? "AUTO_RISK_PERCENT" : "FIXED_LOT";

  return {
    version: 1,
    executionFamily: "V6_STANDALONE",
    orderSizingMode: "FIXED_LOT",
    requestedSizingMode: normalizedRequested,
    gatewayExecutionMode: "FIXED_LOT",
    configuredLot,
    configuredLotValidInLocalConfig: configuredLot !== null,
    configuredLotSource: "getCanonicalFixedLot",
    brokerVolumeValidatedForNextOrder: false,
    automaticCapitalSizingActiveOnV6: false,
    uiAutoLotClaimAllowed: false,
    autoLotPolicyApprovedForLive: false,
    phase7cAutoLotComparisonIsShadowOnly: true,
    verificationScope: "SOURCE_POLICY_NOT_DEPLOYED_RUNTIME_OR_BROKER_PROOF",
    riskPolicy: {
      perTradePercent: "WARNING_ONLY",
      portfolioPercent: "WARNING_ONLY",
      drawdownPercent: "WARNING_ONLY",
      dailyLossForNewOrders: "HARD_GATE",
      freeMarginForNewOrders: "HARD_GATE",
    },
  };
}
