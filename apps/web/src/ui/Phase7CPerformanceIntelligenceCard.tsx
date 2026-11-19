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
import { getPhase7CPerformanceIntelligence } from "../phase7c-performance-intelligence-api";
import type { Phase7CPerformanceCorrelationVerdict } from "../phase7c-performance-intelligence-types";

function verdictColor(
  verdict: Phase7CPerformanceCorrelationVerdict,
): "success" | "warning" | "default" {
  if (verdict === "EXACT") return "success";
  if (verdict === "AMBIGUOUS") return "warning";
  return "default";
}

function pnlLabel(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}`;
}

export function Phase7CPerformanceIntelligenceCard() {
  const [showDetails, setShowDetails] = useState(false);
  const query = useQuery({
    queryKey: ["phase7c-performance-intelligence", 90, "XAUUSD"],
    queryFn: () => getPhase7CPerformanceIntelligence(90, "XAUUSD"),
    refetchInterval: 15000,
    retry: false,
  });

  const snapshot = query.data;
  const incomplete = Boolean(
    snapshot && (snapshot.coverage.ambiguousTrades > 0 || snapshot.coverage.unmatchedTrades > 0),
  );
  const recentTrades = snapshot?.trades.slice(-8).reverse() ?? [];
  const topRules = snapshot?.rules.slice(0, 6) ?? [];
  const entryFunnel = snapshot?.entryFunnel ?? [];
  const sidewayM5Confirmation = snapshot?.sidewayM5Confirmation ?? [];

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
                <Typography variant="h6">Performance Intelligence v2</Typography>
                <Chip size="small" label="READ ONLY" variant="outlined" />
              </Stack>
              <Typography variant="body2" color="text.secondary">
                Hiệu quả rule/entry dựa trên MT5 accounting và decision evidence đã persist; không tự chỉnh strategy, risk, ARM hoặc lệnh.
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
              <Typography variant="body2">Đang đọc Performance Intelligence…</Typography>
            </Stack>
          ) : null}

          {query.isError ? (
            <Alert severity="warning">
              Không đọc được Performance Intelligence. Không có hành động tự động nào được thực hiện.
            </Alert>
          ) : null}

          {snapshot ? (
            <>
              <Stack direction={{ xs: "column", md: "row" }} spacing={1.5}>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">System trades</Typography>
                  <Typography variant="h6">{snapshot.coverage.totalSystemTrades}</Typography>
                </Box>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">EXACT</Typography>
                  <Typography variant="h6">{snapshot.coverage.exactTrades}</Typography>
                </Box>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">AMBIGUOUS</Typography>
                  <Typography variant="h6">{snapshot.coverage.ambiguousTrades}</Typography>
                </Box>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">UNMATCHED</Typography>
                  <Typography variant="h6">{snapshot.coverage.unmatchedTrades}</Typography>
                </Box>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">Exact coverage</Typography>
                  <Typography variant="h6">{snapshot.coverage.correlationCoveragePercent.toFixed(1)}%</Typography>
                </Box>
              </Stack>

              {incomplete ? (
                <Alert severity="warning">
                  Attribution chưa đầy đủ. AMBIGUOUS/UNMATCHED bị loại khỏi rule profitability; hệ thống không dùng time/price fuzzy matching để lấp khoảng trống.
                </Alert>
              ) : (
                <Alert severity="success">
                  Tất cả system trades trong cửa sổ hiện tại có explicit identity correlation.
                </Alert>
              )}

              {showDetails ? (
                <>
                  <Divider />

                  <Box>
                    <Typography variant="subtitle2" gutterBottom>Entry type performance</Typography>
                    <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                      {snapshot.entryTypes.map((item) => (
                        <Chip
                          key={item.entryType}
                          size="small"
                          label={`${item.entryType}: ${item.sampleSize} · PnL ${pnlLabel(item.netPnl)} · WR ${item.winRatePercent.toFixed(1)}%`}
                          variant="outlined"
                        />
                      ))}
                    </Stack>
                  </Box>

                  <Box>
                    <Typography variant="subtitle2" gutterBottom>Sideway M5 confirmation age</Typography>
                    <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                      {sidewayM5Confirmation.map((item) => (
                        <Chip
                          key={item.path}
                          size="small"
                          label={`${item.path}: n=${item.sampleSize} · PnL ${pnlLabel(item.netPnl)} · WR ${item.winRatePercent.toFixed(1)}%`}
                          variant="outlined"
                        />
                      ))}
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      Chỉ dùng trade correlation EXACT. M5_CURRENT = age 0; M5_CARRY_1 = confirmation từ cây M5 liền trước.
                    </Typography>
                  </Box>

                  <Box>
                    <Typography variant="subtitle2" gutterBottom>Entry funnel / blocked reasons</Typography>
                    <Stack spacing={0.75}>
                      {entryFunnel.map((item) => (
                        <Stack
                          key={item.strategy}
                          direction={{ xs: "column", md: "row" }}
                          spacing={1}
                          justifyContent="space-between"
                        >
                          <Typography variant="body2" fontWeight={600}>{item.strategy}</Typography>
                          <Typography variant="body2" color="text.secondary">
                            decision {item.observedEntryDecisionEvents} · evaluated {item.ruleEvaluatedEvents} · blocked {item.blockedEvents} · clear {item.clearRuleEvents} · submit {item.entrySubmitEvents} · fill {item.entryFilledEvents}
                            {item.blockedReasons.length > 0
                              ? ` · top block ${item.blockedReasons.slice(0, 3).map((reason) => `${reason.rule}(${reason.count})`).join(", ")}`
                              : ""}
                          </Typography>
                        </Stack>
                      ))}
                    </Stack>
                  </Box>

                  <Box>
                    <Typography variant="subtitle2" gutterBottom>Top persisted rule evidence</Typography>
                    {topRules.length === 0 ? (
                      <Typography variant="body2" color="text.secondary">Chưa có rule evidence đủ điều kiện EXACT.</Typography>
                    ) : (
                      <Stack spacing={0.75}>
                        {topRules.map((rule) => (
                          <Stack
                            key={`${rule.strategy}:${rule.rule}`}
                            direction={{ xs: "column", sm: "row" }}
                            spacing={1}
                            justifyContent="space-between"
                          >
                            <Typography variant="body2">
                              {rule.strategy} · {rule.rule}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              n={rule.sampleSize} · PnL {pnlLabel(rule.netPnl)} · E {pnlLabel(rule.expectancy)}
                            </Typography>
                          </Stack>
                        ))}
                      </Stack>
                    )}
                  </Box>

                  <Divider />

                  <Box>
                    <Typography variant="subtitle2" gutterBottom>Decision audit sources</Typography>
                    <Stack spacing={0.75}>
                      {snapshot.auditSources.map((source) => (
                        <Stack
                          key={`${source.strategy}:${source.relativePath}`}
                          direction={{ xs: "column", sm: "row" }}
                          spacing={1}
                          justifyContent="space-between"
                        >
                          <Typography variant="body2" sx={{ fontFamily: "monospace" }}>
                            {source.relativePath}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {source.available ? "AVAILABLE" : "MISSING"} · rows {source.parsedRows} · malformed {source.malformedRows}
                          </Typography>
                        </Stack>
                      ))}
                    </Stack>
                  </Box>

                  <Divider />

                  <Box>
                    <Typography variant="subtitle2" gutterBottom>Recent correlated system trades</Typography>
                    {recentTrades.length === 0 ? (
                      <Typography variant="body2" color="text.secondary">Chưa có system trade đóng trong cửa sổ 90 ngày.</Typography>
                    ) : (
                      <Stack spacing={1}>
                        {recentTrades.map((trade) => (
                          <Stack
                            key={trade.id}
                            direction={{ xs: "column", md: "row" }}
                            spacing={1}
                            justifyContent="space-between"
                            alignItems={{ md: "center" }}
                          >
                            <Box>
                              <Typography variant="body2" fontWeight={600}>
                                {trade.attribution.performanceStrategy} · {trade.side} · position {trade.positionId}
                              </Typography>
                              <Typography variant="caption" color="text.secondary">
                                {new Date(trade.closedAt).toLocaleString("vi-VN")} · {trade.attribution.entryType} · {trade.attribution.regime ?? "regime N/A"}
                                {trade.attribution.performanceStrategy === "SIDEWAY"
                                  ? ` · M5 age ${trade.attribution.confirmationAgeBars ?? "N/A"}`
                                  : ""}
                              </Typography>
                            </Box>
                            <Stack direction="row" spacing={1} alignItems="center">
                              <Typography variant="body2">PnL {pnlLabel(trade.netPnl)}</Typography>
                              <Chip
                                size="small"
                                label={trade.correlation.verdict}
                                color={verdictColor(trade.correlation.verdict)}
                                variant={trade.correlation.verdict === "UNMATCHED" ? "outlined" : "filled"}
                              />
                            </Stack>
                          </Stack>
                        ))}
                      </Stack>
                    )}
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
