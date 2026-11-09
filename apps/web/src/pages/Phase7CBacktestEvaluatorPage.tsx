import { useState, useEffect, useCallback } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  FormControlLabel,
  Grid,
  MenuItem,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import PlayArrowRounded from "@mui/icons-material/PlayArrowRounded";
import ScienceRounded from "@mui/icons-material/ScienceRounded";
import AutoGraphRounded from "@mui/icons-material/AutoGraphRounded";
import { Phase7CBacktestPage } from "./Phase7CBacktestPage";
import { Phase7CAutoLotBacktestPage } from "./Phase7CAutoLotBacktestPage";
import { MetricCard } from "../ui/MetricCard";
import { Sparkline } from "../ui/Sparkline";

type UpgradeKey =
  | "dynamicAtrManagement"
  | "sessionLiquiditySweep"
  | "macroNewsSpreadGuard"
  | "consecutiveLossCooldown"
  | "confidenceTieredLot";

interface EvaluatorResponse {
  config: {
    days: number;
    strategyMode: string;
    sizingMode: string;
    startingBalance: number;
    fixedLot: number;
    riskPercent: number;
    upgrades: Record<UpgradeKey, boolean>;
  };
  baseline: {
    totalTrades: number;
    wins: number;
    losses: number;
    breakevens: number;
    winRatePercent: number;
    netPnlUsd: number;
    returnPercent: number;
    profitFactor: number;
    expectancyUsd: number;
    averageR: number;
    sharpeRatio: number;
    maxDrawdownUsd: number;
    maxDrawdownPercent: number;
    earlyBeSweepCount: number;
    partialCloseCount: number;
  };
  optimized: {
    totalTrades: number;
    wins: number;
    losses: number;
    breakevens: number;
    winRatePercent: number;
    netPnlUsd: number;
    returnPercent: number;
    profitFactor: number;
    expectancyUsd: number;
    averageR: number;
    sharpeRatio: number;
    maxDrawdownUsd: number;
    maxDrawdownPercent: number;
    earlyBeSweepCount: number;
    partialCloseCount: number;
    newsLossesAvoided: number;
  };
  delta: {
    netPnlUsd: number;
    winRateDiff: number;
    profitFactorDiff: number;
    drawdownReductionPct: number;
    beSweepsSaved: number;
  };
  equityCurve: Array<{
    step: number;
    dateLabel: string;
    baselineEquity: number;
    optimizedEquity: number;
    baselineDrawdownPct: number;
    optimizedDrawdownPct: number;
  }>;
  byStrategy: Array<{
    key: string;
    label: string;
    trades: number;
    winRatePercent: number;
    netPnlUsd: number;
    profitFactor: number;
    averageR: number;
    verdict: string;
  }>;
  byPattern: Array<{
    key: string;
    label: string;
    trades: number;
    winRatePercent: number;
    netPnlUsd: number;
    profitFactor: number;
    averageR: number;
    verdict: string;
  }>;
  bySession: Array<{
    key: string;
    label: string;
    trades: number;
    winRatePercent: number;
    netPnlUsd: number;
    profitFactor: number;
    averageR: number;
    verdict: string;
  }>;
  proposals: Array<{
    id: UpgradeKey;
    title: string;
    category: string;
    priority: string;
    currentWeakness: string;
    proposedSolution: string;
    quantifiedImpact: string;
    targetModule: string;
    enabled: boolean;
  }>;
  trades: Array<{
    id: string;
    closedAt: string;
    session: string;
    strategy: string;
    pattern: string;
    side: string;
    lot: number;
    entry: number;
    stopLoss: number;
    tp1: number;
    exit: number;
    exitReason: string;
    rMultiple: number;
    baselinePnlUsd: number;
    optimizedPnlUsd: number;
    improvementNote: string;
  }>;
}

function fmtMoney(v: number) {
  return `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`;
}

export function Phase7CBacktestEvaluatorPage() {
  const [subTab, setSubTab] = useState(0);
  const [days, setDays] = useState(90);
  const [strategyMode, setStrategyMode] = useState("AUTO");
  const [sizingMode, setSizingMode] = useState("CONFIDENCE_TIERED");
  const [startingBalance, setStartingBalance] = useState(10000);
  const [upgrades, setUpgrades] = useState<Record<UpgradeKey, boolean>>({
    dynamicAtrManagement: true,
    sessionLiquiditySweep: true,
    macroNewsSpreadGuard: true,
    consecutiveLossCooldown: true,
    confidenceTieredLot: true,
  });
  const [data, setData] = useState<EvaluatorResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const runEvaluator = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/phase7c/backtest-evaluator", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          days,
          strategyMode,
          sizingMode,
          startingBalance,
          upgrades,
        }),
      });
      if (res.ok) {
        setData((await res.json()) as EvaluatorResponse);
      }
    } catch {
      // ignore offline preview error
    } finally {
      setLoading(false);
    }
  }, [days, strategyMode, sizingMode, startingBalance, upgrades]);

  useEffect(() => {
    // Defer state updates out of the effect body. The button may still run an
    // immediate evaluation; changing any input refreshes the read-only preview.
    const timer = window.setTimeout(() => { void runEvaluator(); }, 0);
    return () => window.clearTimeout(timer);
  }, [runEvaluator]);

  function toggleUpgrade(key: UpgradeKey) {
    setUpgrades((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      return next;
    });
  }

  return (
    <Stack spacing={2.2}>
      <Box
        sx={{
          p: 2.2,
          borderRadius: 3,
          bgcolor: "rgba(3,10,18,.86)",
          border: "1px solid rgba(233,185,73,.28)",
        }}
      >
        <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" gap={2} alignItems={{ md: "center" }}>
          <Box>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <ScienceRounded color="primary" />
              <Typography variant="h5" fontWeight={950}>
                TRUNG TÂM BACKTEST & ĐÁNH GIÁ HIỆU SUẤT BOT
              </Typography>
              <Chip label="BOT V1 HIỆN HỮU vs BOT V2 ĐỀ XUẤT" color="warning" size="small" sx={{ fontWeight: 900 }} />
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.6 }}>
              Kiểm thử lịch sử XAUUSD, đối chiếu hiệu suất thực tế (Forward vs Backtest), đánh giá từng mẫu hình nến và mô phỏng 5 đề xuất nâng cấp Bot.
            </Typography>
          </Box>
          <Tabs
            value={subTab}
            onChange={(_e, val) => setSubTab(val)}
            sx={{
              bgcolor: "rgba(255,255,255,.03)",
              borderRadius: 2,
              p: 0.5,
            }}
          >
            <Tab label="1. Mô phỏng & Đề xuất nâng cấp Bot" sx={{ fontWeight: 800, fontSize: 13 }} />
            <Tab label="2. Canonical MT5 Replay" sx={{ fontWeight: 800, fontSize: 13 }} />
            <Tab label="3. Auto-Lot Shadow vs Fixed" sx={{ fontWeight: 800, fontSize: 13 }} />
          </Tabs>
        </Stack>
      </Box>

      {subTab === 1 && <Phase7CBacktestPage />}
      {subTab === 2 && <Phase7CAutoLotBacktestPage />}

      {subTab === 0 && (
        <Stack spacing={2.2}>
          <Card variant="outlined" sx={{ borderRadius: 3, bgcolor: "rgba(6,13,24,.88)", borderColor: "rgba(148,163,184,.18)" }}>
            <CardContent>
              <Grid container spacing={2} alignItems="center">
                <Grid size={{ xs: 12, sm: 6, md: 2.5 }}>
                  <TextField
                    select
                    fullWidth
                    size="small"
                    label="Khoảng thời gian Backtest"
                    value={days}
                    onChange={(e) => setDays(Number(e.target.value))}
                  >
                    {[30, 90, 180, 365].map((d) => (
                      <MenuItem key={d} value={d}>
                        {d} ngày gần nhất
                      </MenuItem>
                    ))}
                  </TextField>
                </Grid>
                <Grid size={{ xs: 12, sm: 6, md: 3 }}>
                  <TextField
                    select
                    fullWidth
                    size="small"
                    label="Chế độ Chiến lược"
                    value={strategyMode}
                    onChange={(e) => setStrategyMode(e.target.value)}
                  >
                    <MenuItem value="AUTO">AUTO (Kết hợp Đa Bot)</MenuItem>
                    <MenuItem value="TREND">Chỉ chạy Bot TREND</MenuItem>
                    <MenuItem value="SIDEWAY">Chỉ chạy Bot SIDEWAY</MenuItem>
                    <MenuItem value="PROPOSED_V2">Full Bot V2 (+Liquidity Sweep)</MenuItem>
                  </TextField>
                </Grid>
                <Grid size={{ xs: 12, sm: 6, md: 3 }}>
                  <TextField
                    select
                    fullWidth
                    size="small"
                    label="Cơ chế Quản lý vốn (Sizing)"
                    value={sizingMode}
                    onChange={(e) => setSizingMode(e.target.value)}
                  >
                    <MenuItem value="CONFIDENCE_TIERED">Chia bậc theo Điểm Tin Cậy (Đề xuất)</MenuItem>
                    <MenuItem value="RISK_PERCENT">Theo % Rủi ro cố định (0.8%)</MenuItem>
                    <MenuItem value="FIXED_LOT">Cố định Lot (0.12 lot)</MenuItem>
                  </TextField>
                </Grid>
                <Grid size={{ xs: 12, sm: 6, md: 1.5 }}>
                  <TextField
                    fullWidth
                    size="small"
                    type="number"
                    label="Vốn gốc ($)"
                    value={startingBalance}
                    onChange={(e) => setStartingBalance(Number(e.target.value))}
                  />
                </Grid>
                <Grid size={{ xs: 12, md: 2 }}>
                  <Button
                    fullWidth
                    variant="contained"
                    startIcon={<PlayArrowRounded />}
                    onClick={() => void runEvaluator()}
                    disabled={loading}
                    sx={{ height: 40, fontWeight: 900 }}
                  >
                    {loading ? "Đang chạy..." : "Chạy Đánh Giá"}
                  </Button>
                </Grid>
              </Grid>

              <Box sx={{ mt: 2, pt: 1.5, borderTop: "1px solid rgba(148,163,184,.12)" }}>
                <Typography variant="caption" color="primary" fontWeight={900}>
                  BẬT / TẮT 5 ĐỀ XUẤT NÂNG CẤP CHO BOT HIỆN TẠI ĐỂ XEM MỨC CẢI THIỆN HIỆU SUẤT:
                </Typography>
                <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.8 }}>
                  <FormControlLabel
                    control={<Checkbox size="small" checked={upgrades.dynamicAtrManagement} onChange={() => toggleUpgrade("dynamicAtrManagement")} />}
                    label={<Typography variant="body2" fontWeight={700}>1. Dời BE & Chốt 1/3 động theo ATR (thay cố định +$6/+$10)</Typography>}
                  />
                  <FormControlLabel
                    control={<Checkbox size="small" checked={upgrades.sessionLiquiditySweep} onChange={() => toggleUpgrade("sessionLiquiditySweep")} />}
                    label={<Typography variant="body2" fontWeight={700}>2. Bổ sung Bot 3: Bẫy Quét Thanh Khoản Đỉnh/Đáy Phiên</Typography>}
                  />
                  <FormControlLabel
                    control={<Checkbox size="small" checked={upgrades.macroNewsSpreadGuard} onChange={() => toggleUpgrade("macroNewsSpreadGuard")} />}
                    label={<Typography variant="body2" fontWeight={700}>3. Cổng chặn Tin Đỏ (CPI/NFP/FOMC) & Giãn Spread</Typography>}
                  />
                  <FormControlLabel
                    control={<Checkbox size="small" checked={upgrades.consecutiveLossCooldown} onChange={() => toggleUpgrade("consecutiveLossCooldown")} />}
                    label={<Typography variant="body2" fontWeight={700}>4. Ngắt mạch nghỉ 60p sau 2 lệnh thua liên tiếp</Typography>}
                  />
                  <FormControlLabel
                    control={<Checkbox size="small" checked={upgrades.confidenceTieredLot} onChange={() => toggleUpgrade("confidenceTieredLot")} />}
                    label={<Typography variant="body2" fontWeight={700}>5. Chia bậc Lot theo Confidence (0.4% → 1.0%)</Typography>}
                  />
                </Stack>
              </Box>
            </CardContent>
          </Card>

          {data ? (
            <>
              <Grid container spacing={2}>
                <Grid size={{ xs: 12, sm: 6, xl: 3 }}>
                  <MetricCard
                    label="Lợi nhuận ròng (Bot Đề Xuất V2 vs Hiện tại)"
                    value={`${fmtMoney(data.optimized.netPnlUsd)} (+${data.optimized.returnPercent}%)`}
                    detail={`Bot hiện tại: ${fmtMoney(data.baseline.netPnlUsd)} · Tăng thêm ${fmtMoney(data.delta.netPnlUsd)}`}
                    tone="success.main"
                  />
                </Grid>
                <Grid size={{ xs: 12, sm: 6, xl: 3 }}>
                  <MetricCard
                    label="Tỷ lệ thắng (Win Rate)"
                    value={`${data.optimized.winRatePercent.toFixed(1)}%`}
                    detail={`Bot hiện tại: ${data.baseline.winRatePercent.toFixed(1)}% · Cải thiện +${data.delta.winRateDiff.toFixed(1)}%`}
                    tone="success.main"
                  />
                </Grid>
                <Grid size={{ xs: 12, sm: 6, xl: 3 }}>
                  <MetricCard
                    label="Profit Factor & Sharpe Ratio"
                    value={`PF ${data.optimized.profitFactor.toFixed(2)} · Sharpe ${data.optimized.sharpeRatio.toFixed(2)}`}
                    detail={`Bot hiện tại: PF ${data.baseline.profitFactor.toFixed(2)} · Kỳ vọng ${data.optimized.averageR.toFixed(2)}R/lệnh`}
                    tone="success.main"
                  />
                </Grid>
                <Grid size={{ xs: 12, sm: 6, xl: 3 }}>
                  <MetricCard
                    label="Sụt giảm tối đa (Max Drawdown)"
                    value={`${data.optimized.maxDrawdownPercent.toFixed(2)}% ($${data.optimized.maxDrawdownUsd.toFixed(0)})`}
                    detail={`Bot hiện tại: ${data.baseline.maxDrawdownPercent.toFixed(2)}% · Giảm rủi ro −${data.delta.drawdownReductionPct}% · Cứu ${data.delta.beSweepsSaved} lệnh quét BE`}
                    tone="info.main"
                  />
                </Grid>
              </Grid>

              <Grid container spacing={2}>
                <Grid size={{ xs: 12, xl: 7 }}>
                  <Card variant="outlined" sx={{ height: "100%", borderRadius: 3 }}>
                    <CardContent>
                      <Stack direction="row" justifyContent="space-between" alignItems="center">
                        <Typography fontWeight={900}>Đường tăng trưởng vốn (Equity Curve — Bot V2 Tối ưu)</Typography>
                        <Chip size="small" color="success" label={`+${data.optimized.returnPercent}% / ${data.config.days} ngày`} />
                      </Stack>
                      <Box sx={{ mt: 2 }}>
                        <Sparkline values={data.equityCurve.map((p) => p.optimizedEquity)} positive />
                      </Box>
                    </CardContent>
                  </Card>
                </Grid>
                <Grid size={{ xs: 12, xl: 5 }}>
                  <Card variant="outlined" sx={{ height: "100%", borderRadius: 3 }}>
                    <CardContent>
                      <Typography fontWeight={900}>Bảng đối chiếu trực tiếp: Bot Hiện Tại vs Bot Đề Xuất V2</Typography>
                      <Table size="small" sx={{ mt: 1 }}>
                        <TableHead>
                          <TableRow>
                            <TableCell>Chỉ số đánh giá</TableCell>
                            <TableCell align="right">Bot Hiện Tại (V1)</TableCell>
                            <TableCell align="right">Bot Đề Xuất (V2)</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          <TableRow>
                            <TableCell>Tổng số lệnh</TableCell>
                            <TableCell align="right">{data.baseline.totalTrades}</TableCell>
                            <TableCell align="right"><b>{data.optimized.totalTrades}</b></TableCell>
                          </TableRow>
                          <TableRow>
                            <TableCell>Win Rate (%)</TableCell>
                            <TableCell align="right">{data.baseline.winRatePercent}%</TableCell>
                            <TableCell align="right" sx={{ color: "success.main", fontWeight: 900 }}>{data.optimized.winRatePercent}%</TableCell>
                          </TableRow>
                          <TableRow>
                            <TableCell>Lợi nhuận ròng ($)</TableCell>
                            <TableCell align="right">{fmtMoney(data.baseline.netPnlUsd)}</TableCell>
                            <TableCell align="right" sx={{ color: "success.main", fontWeight: 900 }}>{fmtMoney(data.optimized.netPnlUsd)}</TableCell>
                          </TableRow>
                          <TableRow>
                            <TableCell>Profit Factor</TableCell>
                            <TableCell align="right">{data.baseline.profitFactor.toFixed(2)}</TableCell>
                            <TableCell align="right" sx={{ color: "success.main", fontWeight: 900 }}>{data.optimized.profitFactor.toFixed(2)}</TableCell>
                          </TableRow>
                          <TableRow>
                            <TableCell>Lệnh bị quét BE sớm (tiếc nuối)</TableCell>
                            <TableCell align="right" sx={{ color: "warning.main" }}>{data.baseline.earlyBeSweepCount} lệnh</TableCell>
                            <TableCell align="right" sx={{ color: "success.main", fontWeight: 900 }}>{data.optimized.earlyBeSweepCount} lệnh</TableCell>
                          </TableRow>
                          <TableRow>
                            <TableCell>Lệnh né được bão tin Đỏ Mỹ</TableCell>
                            <TableCell align="right">0 lệnh</TableCell>
                            <TableCell align="right" sx={{ color: "info.main", fontWeight: 900 }}>{data.optimized.newsLossesAvoided} lệnh</TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                </Grid>
              </Grid>

              <Grid container spacing={2}>
                <Grid size={{ xs: 12, lg: 6 }}>
                  <Card variant="outlined" sx={{ borderRadius: 3, height: "100%" }}>
                    <CardContent>
                      <Typography fontWeight={900}>Hiệu suất theo từng Mẫu Hình Nến (Chart Pattern)</Typography>
                      <Table size="small" sx={{ mt: 1 }}>
                        <TableHead>
                          <TableRow>
                            <TableCell>Mẫu hình nến</TableCell>
                            <TableCell align="right">Số lệnh</TableCell>
                            <TableCell align="right">Win %</TableCell>
                            <TableCell align="right">PF</TableCell>
                            <TableCell align="right">Lãi ròng</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {data.byPattern.map((row) => (
                            <TableRow key={row.key}>
                              <TableCell>{row.label}</TableCell>
                              <TableCell align="right">{row.trades}</TableCell>
                              <TableCell align="right">{row.winRatePercent.toFixed(1)}%</TableCell>
                              <TableCell align="right">{row.profitFactor.toFixed(2)}</TableCell>
                              <TableCell align="right" sx={{ color: row.netPnlUsd >= 0 ? "success.main" : "error.main", fontWeight: 800 }}>
                                {fmtMoney(row.netPnlUsd)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                </Grid>
                <Grid size={{ xs: 12, lg: 6 }}>
                  <Card variant="outlined" sx={{ borderRadius: 3, height: "100%" }}>
                    <CardContent>
                      <Typography fontWeight={900}>Hiệu suất theo từng Bot & Phiên giao dịch (Á / Âu / Mỹ)</Typography>
                      <Table size="small" sx={{ mt: 1 }}>
                        <TableHead>
                          <TableRow>
                            <TableCell>Phân nhóm</TableCell>
                            <TableCell align="right">Số lệnh</TableCell>
                            <TableCell align="right">Win %</TableCell>
                            <TableCell align="right">Avg R</TableCell>
                            <TableCell align="right">Lãi ròng</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {[...data.byStrategy, ...data.bySession].map((row) => (
                            <TableRow key={row.key}>
                              <TableCell>{row.label}</TableCell>
                              <TableCell align="right">{row.trades}</TableCell>
                              <TableCell align="right">{row.winRatePercent.toFixed(1)}%</TableCell>
                              <TableCell align="right">{row.averageR.toFixed(2)}R</TableCell>
                              <TableCell align="right" sx={{ color: row.netPnlUsd >= 0 ? "success.main" : "error.main", fontWeight: 800 }}>
                                {fmtMoney(row.netPnlUsd)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                </Grid>
              </Grid>

              <Card variant="outlined" sx={{ borderRadius: 3, borderColor: "rgba(233,185,73,.35)" }}>
                <CardContent>
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
                    <AutoGraphRounded color="primary" />
                    <Typography variant="h6" fontWeight={950}>
                      5 ĐỀ XUẤT CẢI TIẾN CỤ THỂ CHO BOT HIỆN TẠI CỦA BẠN
                    </Typography>
                  </Stack>
                  <Grid container spacing={2}>
                    {data.proposals.map((item) => (
                      <Grid key={item.id} size={{ xs: 12, md: 6 }}>
                        <Box
                          sx={{
                            p: 2,
                            borderRadius: 2.5,
                            border: item.enabled ? "1px solid rgba(74,222,128,.38)" : "1px solid rgba(148,163,184,.16)",
                            bgcolor: item.enabled ? "rgba(74,222,128,.04)" : "rgba(255,255,255,.02)",
                            height: "100%",
                          }}
                        >
                          <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
                            <Chip size="small" color="primary" variant="outlined" label={item.category} />
                            <Chip
                              size="small"
                              color={item.enabled ? "success" : "default"}
                              label={item.enabled ? "ĐANG BẬT TRONG BACKTEST" : "ĐANG TẮT"}
                            />
                          </Stack>
                          <Typography variant="subtitle1" fontWeight={900} sx={{ mt: 1 }}>
                            {item.title}
                          </Typography>
                          <Typography variant="body2" color="warning.main" sx={{ mt: 0.8 }}>
                            <b>Điểm nghẽn hiện tại:</b> {item.currentWeakness}
                          </Typography>
                          <Typography variant="body2" color="text.primary" sx={{ mt: 0.6 }}>
                            <b>Giải pháp nâng cấp:</b> {item.proposedSolution}
                          </Typography>
                          <Alert severity="success" sx={{ mt: 1.2, py: 0.4 }}>
                            <b>Hiệu quả định lượng:</b> {item.quantifiedImpact}
                          </Alert>
                        </Box>
                      </Grid>
                    ))}
                  </Grid>
                </CardContent>
              </Card>
            </>
          ) : null}
        </Stack>
      )}
    </Stack>
  );
}
