import { useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Grid,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import PlayArrowRounded from "@mui/icons-material/PlayArrowRounded";
import { runPhase7ESupertrendBacktest } from "../api";
import type { Phase7EMetrics, Phase7ESupertrendResult } from "../phase7e-types";

const DAY = 86_400_000;

function ymd(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function metric(value: number | null, digits = 2) {
  return value === null ? "—" : value.toFixed(digits);
}

function LaneCard({ title, subtitle, metrics }: { title: string; subtitle: string; metrics: Phase7EMetrics }) {
  return (
    <Card variant="outlined" sx={{ height: "100%", bgcolor: "rgba(255,255,255,.015)" }}>
      <CardContent>
        <Typography variant="subtitle1" fontWeight={900}>{title}</Typography>
        <Typography variant="caption" color="text.secondary">{subtitle}</Typography>
        <Grid container spacing={1.4} sx={{ mt: .5 }}>
          <Grid size={{ xs: 6 }}><Typography variant="caption" color="text.secondary">Trades</Typography><Typography variant="h6" fontWeight={800}>{metrics.trades}</Typography></Grid>
          <Grid size={{ xs: 6 }}><Typography variant="caption" color="text.secondary">Win rate</Typography><Typography variant="h6" fontWeight={800}>{metric(metrics.winRatePercent)}%</Typography></Grid>
          <Grid size={{ xs: 6 }}><Typography variant="caption" color="text.secondary">Net P/L</Typography><Typography variant="h6" fontWeight={900} color={metrics.netPnl >= 0 ? "success.main" : "error.main"}>{metrics.netPnl >= 0 ? "+" : ""}${metric(metrics.netPnl)}</Typography></Grid>
          <Grid size={{ xs: 6 }}><Typography variant="caption" color="text.secondary">PF</Typography><Typography variant="h6" fontWeight={800}>{metric(metrics.profitFactor, 3)}</Typography></Grid>
          <Grid size={{ xs: 6 }}><Typography variant="caption" color="text.secondary">Expectancy</Typography><Typography fontWeight={800}>{metrics.expectancy >= 0 ? "+" : ""}${metric(metrics.expectancy)}/trade</Typography></Grid>
          <Grid size={{ xs: 6 }}><Typography variant="caption" color="text.secondary">Max DD</Typography><Typography fontWeight={800}>${metric(metrics.maxDrawdownUsd)}</Typography></Grid>
        </Grid>
      </CardContent>
    </Card>
  );
}

export function Phase7ESupertrendPage() {
  const [yesterday] = useState(() => new Date(Date.now() - DAY));
  const [to, setTo] = useState(ymd(yesterday));
  const [from, setFrom] = useState(ymd(new Date(yesterday.getTime() - 89 * DAY)));
  const [fixedVolume, setFixedVolume] = useState(0.03);
  const [atrPeriod, setAtrPeriod] = useState(10);
  const [multiplier, setMultiplier] = useState(3);
  const [result, setResult] = useState<Phase7ESupertrendResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleQuickRange = (days: number, now: number) => {
    const end = new Date(now - DAY);
    setTo(ymd(end));
    setFrom(ymd(new Date(end.getTime() - (days - 1) * DAY)));
  };

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(await runPhase7ESupertrendBacktest({ from, to, fixedVolume, atrPeriod, multiplier }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Phase 7E research failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Stack spacing={2.5}>
      <Box>
        <Typography variant="h5" fontWeight={900}>Pattern + Dual Supertrend</Typography>
        <Typography color="text.secondary" sx={{ mt: .5 }}>
          Giữ nguyên Engulfing / Two-candle. Bỏ MA20/50/200 khỏi entry và chỉ nhận Pattern khi Supertrend M5 + M15 đồng thuận cùng hướng.
        </Typography>
      </Box>

      <Alert severity="warning">
        Research only. Phase 7B DEMO không bị thay đổi. M15 dùng nến đã đóng; M5 dùng nến M5 đã đóng gần nhất tại thời điểm tín hiệu M15.
      </Alert>

      <Card variant="outlined"><CardContent>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {[30, 90, 180, 365].map((days) => <Button key={days} variant="outlined" size="small" onClick={() => handleQuickRange(days, Date.now())}>{days} ngày</Button>)}
        </Stack>
        <Grid container spacing={1.5} sx={{ mt: .5 }} alignItems="center">
          <Grid size={{ xs: 12, md: 2.2 }}><TextField fullWidth type="date" label="Từ ngày" value={from} onChange={(e) => setFrom(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} /></Grid>
          <Grid size={{ xs: 12, md: 2.2 }}><TextField fullWidth type="date" label="Đến ngày" value={to} onChange={(e) => setTo(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} /></Grid>
          <Grid size={{ xs: 6, md: 1.6 }}><TextField fullWidth type="number" label="Fixed lot" value={fixedVolume} onChange={(e) => setFixedVolume(Number(e.target.value))} /></Grid>
          <Grid size={{ xs: 6, md: 1.6 }}><TextField fullWidth type="number" label="ATR period" value={atrPeriod} onChange={(e) => setAtrPeriod(Number(e.target.value))} /></Grid>
          <Grid size={{ xs: 6, md: 1.6 }}><TextField fullWidth type="number" label="Multiplier" value={multiplier} onChange={(e) => setMultiplier(Number(e.target.value))} inputProps={{ step: .1 }} /></Grid>
          <Grid size={{ xs: 12, md: 2.2 }}><Button fullWidth size="large" variant="contained" startIcon={loading ? <CircularProgress size={18} /> : <PlayArrowRounded />} onClick={run} disabled={loading}>{loading ? "Đang chạy..." : "So sánh MA vs Supertrend"}</Button></Grid>
        </Grid>
      </CardContent></Card>

      {error && <Alert severity="error">{error}</Alert>}

      {result && <>
        <Card variant="outlined"><CardContent>
          <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" spacing={2}>
            <Box>
              <Typography variant="overline" color="text.secondary">PHASE 7E RESEARCH DECISION</Typography>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                <Typography variant="h5" fontWeight={900}>{result.decision.verdict.replaceAll("_", " ")}</Typography>
                <Chip size="small" label={`${result.supertrend.metrics.trades} ST trades`} />
                <Chip size="small" label={`ATR ${result.configuration.atrPeriod} × ${result.configuration.multiplier}`} />
              </Stack>
              <Typography color="text.secondary" sx={{ mt: 1 }}>{result.decision.reason}</Typography>
            </Box>
            <Box sx={{ minWidth: 220 }}>
              <Typography variant="caption" color="text.secondary">EXECUTION ELIGIBLE</Typography>
              <Typography fontWeight={900} color="warning.main">NO</Typography>
              <Typography variant="caption" color="text.secondary">MA entry filter: {result.configuration.maEntryFilter}</Typography>
            </Box>
          </Stack>
        </CardContent></Card>

        <Grid container spacing={2}>
          <Grid size={{ xs: 12, lg: 6 }}><LaneCard title="MA BASELINE" subtitle="Pattern + MA20/50/200" metrics={result.baseline.metrics} /></Grid>
          <Grid size={{ xs: 12, lg: 6 }}><LaneCard title="DUAL SUPERTREND" subtitle={`Pattern + ST M5/M15 · ATR ${result.configuration.atrPeriod} × ${result.configuration.multiplier}`} metrics={result.supertrend.metrics} /></Grid>
        </Grid>

        <Card variant="outlined"><CardContent>
          <Typography variant="subtitle1" fontWeight={900}>Signal diagnostics</Typography>
          <Grid container spacing={1.5} sx={{ mt: .5 }}>
            {[
              ["Pattern raw", result.signalDiagnostics.patternSignals],
              ["M15 cùng hướng", result.signalDiagnostics.m15Aligned],
              ["M5 cùng hướng", result.signalDiagnostics.m5Aligned],
              ["M5 + M15 đồng thuận", result.signalDiagnostics.dualAligned],
              ["M5/M15 bất đồng", result.signalDiagnostics.timeframeDisagreement],
              ["Accepted", result.signalDiagnostics.acceptedSignals],
              ["BUY", result.signalDiagnostics.buySignals],
              ["SELL", result.signalDiagnostics.sellSignals],
            ].map(([label, value]) => <Grid key={String(label)} size={{ xs: 6, md: 3 }}><Typography variant="caption" color="text.secondary">{label}</Typography><Typography variant="h6" fontWeight={800}>{value}</Typography></Grid>)}
          </Grid>
        </CardContent></Card>

        <Card variant="outlined"><CardContent>
          <Typography variant="subtitle1" fontWeight={900}>Δ Dual Supertrend so với MA baseline</Typography>
          <Grid container spacing={1.5} sx={{ mt: .5 }}>
            <Grid size={{ xs: 6, md: 2 }}><Typography variant="caption" color="text.secondary">Trades</Typography><Typography fontWeight={800}>{result.comparison.tradesDelta >= 0 ? "+" : ""}{result.comparison.tradesDelta}</Typography></Grid>
            <Grid size={{ xs: 6, md: 2 }}><Typography variant="caption" color="text.secondary">Win rate</Typography><Typography fontWeight={800}>{result.comparison.winRateDeltaPp >= 0 ? "+" : ""}{metric(result.comparison.winRateDeltaPp)} pp</Typography></Grid>
            <Grid size={{ xs: 6, md: 2 }}><Typography variant="caption" color="text.secondary">Net P/L</Typography><Typography fontWeight={800} color={result.comparison.netPnlDelta >= 0 ? "success.main" : "error.main"}>{result.comparison.netPnlDelta >= 0 ? "+" : ""}${metric(result.comparison.netPnlDelta)}</Typography></Grid>
            <Grid size={{ xs: 6, md: 2 }}><Typography variant="caption" color="text.secondary">PF</Typography><Typography fontWeight={800}>{result.comparison.profitFactorDelta === null ? "—" : `${result.comparison.profitFactorDelta >= 0 ? "+" : ""}${metric(result.comparison.profitFactorDelta, 3)}`}</Typography></Grid>
            <Grid size={{ xs: 6, md: 2 }}><Typography variant="caption" color="text.secondary">Expectancy</Typography><Typography fontWeight={800}>{result.comparison.expectancyDelta >= 0 ? "+" : ""}${metric(result.comparison.expectancyDelta)}</Typography></Grid>
            <Grid size={{ xs: 6, md: 2 }}><Typography variant="caption" color="text.secondary">Max DD</Typography><Typography fontWeight={800}>{result.comparison.maxDrawdownDelta >= 0 ? "+" : ""}${metric(result.comparison.maxDrawdownDelta)}</Typography></Grid>
          </Grid>
        </CardContent></Card>

        <Grid container spacing={2}>
          <Grid size={{ xs: 12, md: 6 }}><LaneCard title="SUPERTREND BUY" subtitle="Pattern BUY + M5/M15 BUY" metrics={result.supertrend.buy} /></Grid>
          <Grid size={{ xs: 12, md: 6 }}><LaneCard title="SUPERTREND SELL" subtitle="Pattern SELL + M5/M15 SELL" metrics={result.supertrend.sell} /></Grid>
        </Grid>
      </>}
    </Stack>
  );
}
