import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  Stack,
  Typography,
} from "@mui/material";
import { getPhase7CRecommendationIntelligence } from "../phase7c-recommendation-intelligence-api";
import type { Phase7CRecommendationCandidate } from "../phase7c-recommendation-intelligence-types";

function signed(value: number | null, digits = 2): string {
  if (value === null) return "N/A";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function contextLabel(candidate: Phase7CRecommendationCandidate): string {
  const strategies = candidate.contexts.strategies.length > 0
    ? candidate.contexts.strategies.join(", ")
    : "ALL";
  const regimes = candidate.contexts.regimes.length > 0
    ? candidate.contexts.regimes.join(", ")
    : "ALL";
  return `${strategies} · ${regimes}`;
}

export function Phase7CRecommendationIntelligenceCard() {
  const [showDetails, setShowDetails] = useState(false);
  const query = useQuery({
    queryKey: ["phase7c-recommendation-intelligence", 90, "XAUUSD", 100],
    queryFn: () => getPhase7CRecommendationIntelligence(90, "XAUUSD", 100),
    refetchInterval: 15000,
    retry: false,
  });
  const snapshot = query.data;
  const initialReadError = query.isError && !snapshot;
  const staleRefetchError = query.isRefetchError && Boolean(snapshot);

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Stack
            direction={{ xs: "column", md: "row" }}
            spacing={1}
            justifyContent="space-between"
            alignItems={{ md: "center" }}
          >
            <Box>
              <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" alignItems="center">
                <Typography variant="h6">P5 · Recommendation Intelligence</Typography>
                <Chip size="small" label="READ ONLY" variant="outlined" />
                <Chip size="small" label="ADVISORY ONLY" variant="outlined" />
                <Chip size="small" label="AUTO APPLY: DISABLED" variant="outlined" />
                <Chip size="small" label="AUTO RETUNE: DISABLED" variant="outlined" />
              </Stack>
              <Typography variant="body2" color="text.secondary">
                Tổng hợp bằng chứng P2/P3/P4 thành khuyến nghị deterministic để con người review; không tự thay đổi LIVE.
              </Typography>
            </Box>
            <Button
              size="small"
              variant="text"
              aria-expanded={showDetails}
              onClick={() => setShowDetails((value) => !value)}
            >
              {showDetails ? "Ẩn chi tiết" : "Hiện chi tiết"}
            </Button>
          </Stack>

          {query.isLoading ? (
            <Stack direction="row" spacing={1} alignItems="center">
              <CircularProgress size={18} />
              <Typography variant="body2">Đang đọc P5 recommendation intelligence…</Typography>
            </Stack>
          ) : null}

          {initialReadError ? (
            <Alert severity="warning">
              Không đọc được P5 recommendation intelligence. Runtime, strategy, risk, order, position, mode và ARM không bị thay đổi.
            </Alert>
          ) : null}

          {staleRefetchError ? (
            <Alert severity="warning">
              Không cập nhật được dữ liệu P5 mới; đang hiển thị snapshot gần nhất.
            </Alert>
          ) : null}

          {snapshot ? (
            <>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">Candidates</Typography>
                  <Typography variant="h6">{snapshot.summary.candidateCount}</Typography>
                  <Typography variant="caption">deterministic targets</Typography>
                </Box>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">Review changes</Typography>
                  <Typography variant="h6">{snapshot.summary.reviewChangeCount}</Typography>
                  <Typography variant="caption">human review only</Typography>
                </Box>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">Keep current</Typography>
                  <Typography variant="h6">{snapshot.summary.keepCurrentCount}</Typography>
                  <Typography variant="caption">no proved improvement</Typography>
                </Box>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">Need more evidence</Typography>
                  <Typography variant="h6">{snapshot.summary.collectMoreEvidenceCount}</Typography>
                  <Typography variant="caption">fail-closed</Typography>
                </Box>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">Unavailable</Typography>
                  <Typography variant="h6">{snapshot.summary.unavailableCount}</Typography>
                  <Typography variant="caption">evidence conflict/missing</Typography>
                </Box>
              </Stack>

              <Alert severity="info">
                Evidence score là điểm audit completeness, không phải xác suất thắng hay expected return. BOUNDED không thể đạt HIGH confidence; mọi thay đổi vẫn cần quy trình strategy change riêng.
              </Alert>

              {showDetails ? (
                <>
                  <Divider />
                  <Box>
                    <Typography variant="subtitle2" gutterBottom>Recommendation candidates</Typography>
                    {snapshot.recommendations.length === 0 ? (
                      <Typography variant="body2" color="text.secondary">
                        Chưa có candidate đủ canonical target key trong cửa sổ dữ liệu hiện tại.
                      </Typography>
                    ) : (
                      <Stack spacing={1.5}>
                        {snapshot.recommendations.map((candidate) => (
                          <Box key={candidate.recommendationId}>
                            <Stack
                              direction={{ xs: "column", md: "row" }}
                              spacing={1}
                              justifyContent="space-between"
                              alignItems={{ md: "flex-start" }}
                            >
                              <Box>
                                <Typography variant="body2">
                                  {candidate.targetScope} · {candidate.targetKey}
                                </Typography>
                                <Typography variant="caption" color="text.secondary">
                                  {contextLabel(candidate)} · n={candidate.sampleSize} · P2 exact {candidate.lineage.exactRows}/{candidate.lineage.totalRows}
                                </Typography>
                              </Box>
                              <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
                                <Chip size="small" variant="outlined" label={candidate.action} />
                                <Chip size="small" variant="outlined" label={`CONF ${candidate.confidence}`} />
                                <Chip size="small" variant="outlined" label={`P4 ${candidate.counterfactual.verdict}`} />
                                <Chip size="small" variant="outlined" label={`Evidence ${candidate.evidenceScore}/100`} />
                              </Stack>
                            </Stack>

                            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                              P3: E {signed(candidate.observed.expectancy)} · PnL {signed(candidate.observed.netPnl)} · WR {candidate.observed.winRatePercent.toFixed(1)}% · PF {candidate.observed.profitFactor === null ? "N/A" : candidate.observed.profitFactor.toFixed(2)}
                            </Typography>
                            <Typography variant="caption" color="text.secondary" display="block">
                              P4: scenarios {candidate.counterfactual.scenarioCount} · EXACT {candidate.counterfactual.exactCount} · BOUNDED {candidate.counterfactual.boundedCount} · Δ comparable {signed(candidate.counterfactual.comparableDelta)} · Δ PnL {signed(candidate.counterfactual.counterfactualNetPnlDelta)} · Δ R {signed(candidate.counterfactual.counterfactualRealizedRDelta)}
                            </Typography>
                            <Typography variant="caption" color="text.secondary" display="block">
                              Reasons: {candidate.reasonCodes.length > 0 ? candidate.reasonCodes.join(", ") : "NONE"}
                            </Typography>
                            {candidate.limitations.length > 0 ? (
                              <Typography variant="caption" color="text.secondary" display="block">
                                Limits: {candidate.limitations.join(" · ")}
                              </Typography>
                            ) : null}
                          </Box>
                        ))}
                      </Stack>
                    )}
                  </Box>

                  <Divider />
                  <Box>
                    <Typography variant="subtitle2" gutterBottom>Evidence notes</Typography>
                    <Stack spacing={0.5}>
                      {snapshot.notes.map((note) => (
                        <Typography key={note} variant="caption" color="text.secondary">• {note}</Typography>
                      ))}
                    </Stack>
                  </Box>
                </>
              ) : null}
            </>
          ) : null}
        </Stack>
      </CardContent>
    </Card>
  );
}
