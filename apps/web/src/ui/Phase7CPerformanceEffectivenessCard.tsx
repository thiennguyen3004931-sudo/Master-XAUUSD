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
import { getPhase7CPerformanceEffectiveness } from "../phase7c-performance-effectiveness-api";

function signed(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

function optional(value: number | null, digits = 2): string {
  return value === null ? "N/A" : value.toFixed(digits);
}

export function Phase7CPerformanceEffectivenessCard() {
  const [showDetails, setShowDetails] = useState(false);
  const query = useQuery({
    queryKey: ["phase7c-performance-effectiveness", 90, "XAUUSD", 100],
    queryFn: () => getPhase7CPerformanceEffectiveness(90, "XAUUSD", 100),
    refetchInterval: 15000,
    retry: false,
  });
  const snapshot = query.data;
  const trend = snapshot?.aggregates.strategy.find((item) => item.key === "TREND");
  const sideway = snapshot?.aggregates.strategy.find((item) => item.key === "SIDEWAY");
  const reversal = snapshot?.aggregates.strategy.find((item) => item.key === "REVERSAL");
  const fastMove = snapshot?.aggregates.fastMove;
  const excursion = snapshot?.aggregates.excursion;

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={1}
            justifyContent="space-between"
            alignItems={{ sm: "center" }}
          >
            <Box>
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography variant="h6">P3 · Performance Effectiveness</Typography>
                <Chip size="small" label="READ ONLY" variant="outlined" />
              </Stack>
              <Typography variant="body2" color="text.secondary">
                Đo hiệu quả thực tế của entry, management, M5 excursion và Fast-Move từ bằng chứng đã correlation.
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
              <Typography variant="body2">Đang đọc P3 effectiveness…</Typography>
            </Stack>
          ) : null}

          {query.isError ? (
            <Alert severity="warning">
              Không đọc được P3 effectiveness. Runtime và giao dịch không bị thay đổi.
            </Alert>
          ) : null}

          {snapshot ? (
            <>
              <Stack direction={{ xs: "column", md: "row" }} spacing={1.5}>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">Evidence coverage</Typography>
                  <Typography variant="h6">{snapshot.summary.evidenceCoveragePercent.toFixed(1)}%</Typography>
                  <Typography variant="caption">{snapshot.summary.exactRows}/{snapshot.summary.totalRows} EXACT</Typography>
                </Box>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">TREND expectancy</Typography>
                  <Typography variant="h6">{trend ? signed(trend.expectancy) : "N/A"}</Typography>
                  <Typography variant="caption">n={trend?.sampleSize ?? 0}</Typography>
                </Box>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">SIDEWAY expectancy</Typography>
                  <Typography variant="h6">{sideway ? signed(sideway.expectancy) : "N/A"}</Typography>
                  <Typography variant="caption">n={sideway?.sampleSize ?? 0}</Typography>
                </Box>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">REVERSAL expectancy</Typography>
                  <Typography variant="h6">{reversal ? signed(reversal.expectancy) : "N/A"}</Typography>
                  <Typography variant="caption">n={reversal?.sampleSize ?? 0}</Typography>
                </Box>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">Fast-Move trigger</Typography>
                  <Typography variant="h6">{fastMove?.triggeredRows ?? 0}/{fastMove?.exactSampleSize ?? 0}</Typography>
                  <Typography variant="caption">handoff M5 {fastMove?.handoffRows ?? 0}</Typography>
                </Box>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">Avg locked profit</Typography>
                  <Typography variant="h6">{optional(fastMove?.averageLockedProfitPrice ?? null)}</Typography>
                  <Typography variant="caption">price distance</Typography>
                </Box>
              </Stack>

              {snapshot.summary.evidenceCoveragePercent < 100 ? (
                <Alert severity="warning">
                  Chỉ EXACT correlation được tính vào expectancy và management association; evidence còn thiếu bị giữ fail-closed.
                </Alert>
              ) : (
                <Alert severity="success">
                  Toàn bộ trade trong snapshot hiện có exact correlation evidence.
                </Alert>
              )}

              <Alert severity="info">
                Fast-Move current: TREND +10 / giveback 10 · SIDEWAY +10 / giveback 10. SHADOW_ONLY: chưa replay biến thể từ M5 OHLC vì high/low không chứng minh thứ tự giá intrabar; cần ordered bid/ask evidence.
              </Alert>

              {showDetails ? (
                <>
                  <Divider />
                  <Box>
                    <Typography variant="subtitle2" gutterBottom>M5 excursion evidence</Typography>
                    <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                      <Chip size="small" variant="outlined" label={`n=${excursion?.sampleSize ?? 0}`} />
                      <Chip size="small" variant="outlined" label={`MFE ${optional(excursion?.averageMfePrice ?? null)}`} />
                      <Chip size="small" variant="outlined" label={`MAE ${optional(excursion?.averageMaePrice ?? null)}`} />
                      <Chip size="small" variant="outlined" label={`Giveback ${optional(excursion?.averagePeakToExitGivebackPrice ?? null)}`} />
                      <Chip size="small" variant="outlined" label={`MFE-R ${optional(excursion?.averageMfeR ?? null)}`} />
                      <Chip size="small" variant="outlined" label={`Realized-R ${optional(excursion?.averageRealizedR ?? null)}`} />
                    </Stack>
                  </Box>

                  <Divider />
                  <Box>
                    <Typography variant="subtitle2" gutterBottom>Rule association</Typography>
                    {snapshot.aggregates.rule.length === 0 ? (
                      <Typography variant="body2" color="text.secondary">Chưa có exact rule sample.</Typography>
                    ) : (
                      <Stack spacing={0.75}>
                        {snapshot.aggregates.rule.slice(0, 8).map((item) => (
                          <Stack key={item.key} direction={{ xs: "column", sm: "row" }} spacing={1} justifyContent="space-between">
                            <Typography variant="body2">{item.key}</Typography>
                            <Typography variant="body2" color="text.secondary">
                              n={item.sampleSize} · PnL {signed(item.netPnl)} · E {signed(item.expectancy)} · WR {item.winRatePercent.toFixed(1)}%
                            </Typography>
                          </Stack>
                        ))}
                      </Stack>
                    )}
                  </Box>

                  <Divider />
                  <Box>
                    <Typography variant="subtitle2" gutterBottom>Management association</Typography>
                    {snapshot.aggregates.management.length === 0 ? (
                      <Typography variant="body2" color="text.secondary">Chưa có management event đủ exact identity.</Typography>
                    ) : (
                      <Stack spacing={0.75}>
                        {snapshot.aggregates.management.map((item) => (
                          <Stack key={item.key} direction={{ xs: "column", sm: "row" }} spacing={1} justifyContent="space-between">
                            <Typography variant="body2">{item.key}</Typography>
                            <Typography variant="body2" color="text.secondary">
                              n={item.sampleSize} · PnL {signed(item.netPnl)} · E {signed(item.expectancy)}
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
