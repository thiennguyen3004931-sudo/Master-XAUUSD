export type Phase7CConfiguredLotSettings = {
  trendFixedLot: number;
  sidewayRiskPercent: number;
  sidewayMaxLot: number;
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readProfile(
  source: JsonRecord,
  keys: {
    trendFixedLot: string;
    sidewayRiskPercent: string;
    sidewayMaxLot: string;
  },
): Phase7CConfiguredLotSettings | null {
  const trendFixedLot = finiteNumber(source[keys.trendFixedLot]);
  const sidewayRiskPercent = finiteNumber(source[keys.sidewayRiskPercent]);
  const sidewayMaxLot = finiteNumber(source[keys.sidewayMaxLot]);
  if (trendFixedLot === null || sidewayRiskPercent === null || sidewayMaxLot === null) return null;
  return { trendFixedLot, sidewayRiskPercent, sidewayMaxLot };
}

export function resolveConfiguredLotSettings(
  lotSettingsPayload: unknown,
  accountRiskConfiguration: unknown,
): Phase7CConfiguredLotSettings | null {
  const lotEnvelope = asRecord(lotSettingsPayload);
  const canonicalState = asRecord(lotEnvelope.state);
  const canonical = readProfile(canonicalState, {
    trendFixedLot: "trendFixedLot",
    sidewayRiskPercent: "sidewayRiskPercent",
    sidewayMaxLot: "sidewayMaxLot",
  });
  if (canonical) return canonical;

  return readProfile(asRecord(accountRiskConfiguration), {
    trendFixedLot: "configuredTrendFixedLot",
    sidewayRiskPercent: "configuredSidewayRiskPercent",
    sidewayMaxLot: "configuredSidewayMaxLot",
  });
}
