import { resolvePhase7CDailyRecoveryMagicNumbers } from "./phase7c-daily-recovery-view.service";

export interface Phase7CSourceSafetySnapshot {
  version: 1;
  source: "PHASE7C_SOURCE_SAFETY_CONTRACT";
  generatedAt: number;
  performanceAttribution: {
    liveMagic: {
      status: "ENFORCED";
      trendMagicNumber: number;
      sidewayMagicNumber: number;
      policy: "FAIL_CLOSED_ON_DRIFT";
    };
    validationIsolation: {
      status: "ENFORCED";
      policy: "EXCLUDE_FROM_SYSTEM_SUMMARY";
    };
    mixedOpeningProvenance: {
      status: "ENFORCED";
      policy: "FAIL_CLOSED_TO_NON_SYSTEM";
    };
  };
}

export function getPhase7CSourceSafetyContract(generatedAt = Date.now()): Phase7CSourceSafetySnapshot {
  const liveMagicNumbers = resolvePhase7CDailyRecoveryMagicNumbers({ accountMode: "LIVE" });

  return {
    version: 1,
    source: "PHASE7C_SOURCE_SAFETY_CONTRACT",
    generatedAt,
    performanceAttribution: {
      liveMagic: {
        status: "ENFORCED",
        trendMagicNumber: liveMagicNumbers.trendMagicNumber,
        sidewayMagicNumber: liveMagicNumbers.sidewayMagicNumber,
        policy: "FAIL_CLOSED_ON_DRIFT",
      },
      validationIsolation: {
        status: "ENFORCED",
        policy: "EXCLUDE_FROM_SYSTEM_SUMMARY",
      },
      mixedOpeningProvenance: {
        status: "ENFORCED",
        policy: "FAIL_CLOSED_TO_NON_SYSTEM",
      },
    },
  };
}
