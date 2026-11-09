import { useState } from "react";
import { Button, Stack } from "@mui/material";
import { Phase7CControlCenterCompactSection } from "../ui/Phase7CControlCenterCompactSection";
import { Phase7CCounterfactualIntelligenceCard } from "../ui/Phase7CCounterfactualIntelligenceCard";
import { Phase7CExecutionAuthorizationCard } from "../ui/Phase7CExecutionAuthorizationCard";
import { Phase7CIntelligenceSummaryCard } from "../ui/Phase7CIntelligenceSummaryCard";
import { Phase7COperatorStatusBar } from "../ui/Phase7COperatorStatusBar";
import { Phase7CPerformanceEffectivenessCard } from "../ui/Phase7CPerformanceEffectivenessCard";
import { Phase7CPerformanceIntelligenceCard } from "../ui/Phase7CPerformanceIntelligenceCard";
import { Phase7CRecommendationIntelligenceCard } from "../ui/Phase7CRecommendationIntelligenceCard";
import { Phase7CRuntimeSourceAttestationCard } from "../ui/Phase7CRuntimeSourceAttestationCard";
import { Phase7CControlCenterPage } from "./Phase7CControlCenterPage";

export function Phase7CControlCenterShellPage() {
  const [showOperationalDetails, setShowOperationalDetails] = useState(false);
  const [showIntelligenceDetails, setShowIntelligenceDetails] = useState(false);

  return (
    <Stack spacing={2}>
      <Phase7COperatorStatusBar />

      <Phase7CExecutionAuthorizationCard />

      <Phase7CControlCenterCompactSection
        detailsOpen={showOperationalDetails}
        onToggleDetails={() => setShowOperationalDetails((value) => !value)}
      />
      {showOperationalDetails ? <Phase7CControlCenterPage /> : null}

      <Phase7CIntelligenceSummaryCard />
      <Button
        size="small"
        variant="text"
        onClick={() => setShowIntelligenceDetails((value) => !value)}
        sx={{ alignSelf: "flex-start", fontWeight: 900 }}
      >
        {showIntelligenceDetails ? "Ẩn Intelligence chi tiết" : "Mở Intelligence chi tiết"}
      </Button>
      {showIntelligenceDetails ? (
        <Stack spacing={2}>
          <Phase7CPerformanceIntelligenceCard />
          <Phase7CPerformanceEffectivenessCard />
          <Phase7CCounterfactualIntelligenceCard />
          <Phase7CRecommendationIntelligenceCard />
        </Stack>
      ) : null}

      <Phase7CRuntimeSourceAttestationCard />
    </Stack>
  );
}
