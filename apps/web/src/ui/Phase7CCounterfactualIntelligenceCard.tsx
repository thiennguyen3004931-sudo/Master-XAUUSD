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
import { getPhase7CCounterfactualIntelligence } from "../phase7c-counterfactual-intelligence-api";

function optionalDelta(value: number | null): string {
  if (value === null) return "N/A";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

export function Phase7CCounterfactualIntelligenceCard() {
  const [showDetails, setShowDetails] = useState(false);
  const query = useQuery({
    queryKey: ["phase7c-counterfactual-intelligence", 90, "XAUUSD", 100],
    queryFn: () => getPhase7CCounterfactualIntelligence(90, "XAUUSD", 100),
    refetchInterval: 15000,
    retry: false,
  });
  const snapshot = query.data;

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
                <Typography variant="h6">P4 · Shadow / Counterfactual Intelligence</Typography>
                <Chip size="small" label="READ ONLY" variant="outlined" />
                <Chip size="small" label="SHADOW ONLY" variant="outlined" />
                <Chip size="small" label="AUTO RETUNE: DISABLED" variant="outlined" />
              </Stack>
              <Typography variant="body2" color="text.secondary">
                So sánh actual với các kịch bản shadow chỉ trong phạm vi bằng chứng có thể chứng minh.
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
              <Typography variant="body2">Đang đọc P4 counterfactual…</Typography>
            </Stack>
          ) : null}

          {query.isError ? (
            <Alert severity="warning">
              Không đọc được P4 counterfactual intelligence. Không có thay đổi strategy, risk, order, position, mode hay ARM.
            </Alert>
          ) : null}

          {snapshot ? (
            <>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">Evidence coverage</Typography>
                  <Typography variant="h6">{snapshot.summary.evidenceCoveragePercent.toFixed(1)}%</Typography>
                  <Typography variant="caption">{snapshot.summary.evidenceQualifiedCount}/{snapshot.summary.scenarioCount} qualified</Typography>
                </Box>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">EXACT</Typography>
                  <Typography variant="h6">{snapshot.summary.exactCount}</Typography>
                  <Typography variant="caption">ordered evidence</Typography>
                </Box>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">BOUNDED</Typography>
                  <Typography variant="h6">{snapshot.summary.boundedCount}</Typography>
                  <Typography variant="caption">bounded evidence only</Typography>
                </Box>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">UNAVAILABLE</Typography>
                  <Typography variant="h6">{snapshot.summary.unavailableCount}</Typography>
                  <Typography variant="caption">no provable replay</Typography>
                </Box>
              </Stack>

              <Alert severity="info">
                M5 OHLC không được coi là ordered intrabar evidence. Counterfactual exit, PnL và R giữ null khi không chứng minh được; P4 không sinh recommendation và không tự áp dụng tham số LIVE.
              </Alert>

              {showDetails ? (
                <>
                  <Divider />
                  <Box>
                    <Typography variant="subtitle2" gutterBottom>Scenario families</Typography>
                    <Stack spacing={1}>
                      {snapshot.aggregates.family.map((family) => (
                        <Box key={family.family}>
                          <Stack
                            direction={{ xs: "column", md: "row" }}
                            spacing={1}
                            justifyContent="space-between"
                          >
                            <Typography variant="body2">{family.family}</Typography>
                            <Typography variant="body2" color="text.secondary">
                              n={family.scenarioCount} · EXACT {family.exactCount} · BOUNDED {family.boundedCount} · UNAVAILABLE {family.unavailableCount}
                            </Typography>
                          </Stack>
                          <Typography variant="caption" color="text.secondary">
                            Δ locked avg {optionalDelta(family.averageDeltaLockedProfitPrice)} · Δ exit avg {optionalDelta(family.averageDeltaExitPrice)} · better {family.improvementCount} · worse {family.deteriorationCount}
                          </Typography>
                        </Box>
                      ))}
                    </Stack>
                  </Box>

                  <Divider />
                  <Box>
                    <Typography variant="subtitle2" gutterBottom>Recent shadow scenarios</Typography>
                    {snapshot.scenarios.length === 0 ? (
                      <Typography variant="body2" color="text.secondary">Chưa có scenario.</Typography>
                    ) : (
                      <Stack spacing={0.75}>
                        {snapshot.scenarios.slice(0, 10).map((scenario) => (
                          <Stack
                            key={scenario.scenarioId}
                            direction={{ xs: "column", md: "row" }}
                            spacing={1}
                            justifyContent="space-between"
                          >
                            <Typography variant="body2">
                              {scenario.strategy} · {scenario.family} · {scenario.alternative.description}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              {scenario.evidence.verdict} · Δ locked {optionalDelta(scenario.delta.lockedProfitPrice)}
                            </Typography>
                          </Stack>
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
