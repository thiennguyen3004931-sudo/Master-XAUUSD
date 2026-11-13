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
import { runPhase7ERealignmentBacktest } from "../api";
import type {
  Phase7ERealignmentMetrics,
  Phase7ERealignmentResult,
  Phase7ERealignmentVariant,
} from "../phase7e-realignment-types";

const DAY = 86_400_000;
function ymd(date: Date) { const y = date.getFullYear(); const m = String(date.getMonth() + 1).padStart(2, "0"); const d = String(date.getDate()).padStart(2, "0"); return `${y}-${m}-${d}`; }
function metric(value: number | null, digits = 2) { return value === null ? "—" : value.toFixed(digits); }

function LaneCard({ title, subtitle, metrics, highlight = false }: { title: string; subtitle: string; metrics: Phase7ERealignmentMetrics; highlight?: boolean }) {
  return (
    <Card variant="outlined" sx={{ height: "100%", bgcolor: highlight ? "rgba(233,185,73,.045)" : "rgba(255,255,255,.015)", borderColor: highlight ? "rgba(233,185,73,.35)" : undefined }}>
      <CardContent>
        <Typography variant="subtitle1" fontWeight={900}>{title}</Typography>
        <Typography variant="caption" color="text.secondary">{subtitle}</Typography>
        <Grid container spacing={1.2} sx={{ mt: .5 }}>
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

function VariantBreakdown({ variant }: { variant: Phase7ERealignmentVariant }) {
  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, md: 6 }}><LaneCard title={`${variant.name} · BUY`} subtitle="BUY pattern + M15 ST BUY + fresh M5 BUY flip" metrics={variant.buy} /></Grid>
      <Grid size={{ xs: 12, md: 6 }}><LaneCard title={`${variant.name} · SELL`} subtitle="SELL pattern + M15 ST SELL + fresh M5 SELL flip" metrics={variant.sell} /></Grid>
      <Grid size={{ xs: 12, md: 6 }}><LaneCard title="Engulfing" subtitle={variant.name} metrics={variant.engulfing} /></Grid>
      <Grid size={{ xs: 12, md: 6 }}><LaneCard title="Two-candle" subtitle={variant.name} metrics={variant.twoCandle} /></Grid>
    </Grid>
  );
}

export function Phase7ERealignmentPage() {
  const [yesterday] = useState(() => new Date(Date.now() - DAY));
  const [to, setTo] = useState(ymd(yesterday));
  const [from, setFrom] = useState(ymd(new Date(yesterday.getTime() - 89 * DAY)));
  const [fixedVolume, setFixedVolume] = useState(0.03);
  const [atrPeriod, setAtrPeriod] = useState(10);
  const [multiplier, setMultiplier] = useState(3);
  const [result, setResult] = useState<Phase7ERealignmentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleQuickRange = (days: number, now: number) => { const end = new Date(now - DAY); setTo(ymd(end)); setFrom(ymd(new Date(end.getTime() - (days - 1) * DAY))); };
  const run = async () => {
    setLoading(true); setError(null);
    try { setResult(await runPhase7ERealignmentBacktest({ from, to, fixedVolume, atrPeriod, multiplier })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Phase 7E realignment research failed."); }
    finally { setLoading(false); }
  };

  const preferred = result?.variants.find((variant) => variant.name === result.decision.preferredResearchLane) ?? null;

  return (
    <Stack spacing={2.5}>
      <Box>
        <Typography variant="h5" fontWeight={900}>M15 Supertrend + M5 Re-alignment</Typography>
        <Typography color="text.secondary" sx={{ mt: .5 }}>
          Giữ nguyên 2 mô hình nến. M15 xác định hướng; M5 phải vừa flip lại cùng hướng trong 1 / 2 / 3 nến M5 đã đóng gần nhất.
        </Typography>
      </Box>

      <Alert severity="warning">Research only. Không đổi Phase 7B DEMO. ATR mặc định 10 × 3; chưa tối ưu tham số Supertrend ở bước này.</Alert>

      <Card variant="outlined"><CardContent>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {[30, 90, 180, 365].map((days) => <Button key={days} variant="outlined" size="small" onClick={() => handleQuickRange(days, Date.now())}>{days} ngày</Button>)}
        </Stack>
        <Grid container spacing={1.5} sx={{ mt: .5 }} alignItems="center">
          <Grid size={{ xs: 12, md: 2.2 }}><TextField fullWidth type="date" label="Từ ngày" value={from} onChange={(e) => setFrom(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} /></Grid>
          <Grid size={{ xs: 12, md: 2.2 }}><TextField fullWidth type="date" label="Đến ngày" value={to} onChange={(e) => setTo(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} /></Grid>
          <Grid size={{ xs: 6, md: 1.4 }}><TextField fullWidth type="number" label="Fixed lot" value={fixedVolume} onChange={(e) => setFixedVolume(Number(e.target.value))} /></Grid>
          <Grid size={{ xs: 6, md: 1.4 }}><TextField fullWidth type="number" label="ATR" value={atrPeriod} onChange={(e) => setAtrPeriod(Number(e.target.value))} /></Grid>
          <Grid size={{ xs: 6, md: 1.4 }}><TextField fullWidth type="number" label="Multiplier" value={multiplier} onChange={(e) => setMultiplier(Number(e.target.value))} inputProps={{ step: .1 }} /></Grid>
          <Grid size={{ xs: 12, md: 3 }}><Button fullWidth size="large" variant="contained" startIcon={loading ? <CircularProgress size={18} /> : <PlayArrowRounded />} disabled={loading} onClick={run}>{loading ? "Đang chạy..." : "Đánh giá Fresh Flip 1/2/3"}</Button></Grid>
        </Grid>
      </CardContent></Card>

      {error && <Alert severity="error">{error}</Alert>}

      {result && <>
        <Card variant="outlined"><CardContent>
          <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" spacing={2}>
            <Box>
              <Typography variant="overline" color="text.secondary">PHASE 7E.1 RESEARCH DECISION</Typography>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                <Typography variant="h5" fontWeight={900}>{result.decision.verdict.replaceAll("_", " ")}</Typography>
                <Chip size="small" label={`Preferred: ${result.decision.preferredResearchLane}`} />
                <Chip size="small" label={`ATR ${result.configuration.atrPeriod} × ${result.configuration.multiplier}`} />
              </Stack>
              <Typography color="text.secondary" sx={{ mt: 1 }}>{result.decision.reason}</Typography>
            </Box>
            <Box><Typography variant="caption" color="text.secondary">EXECUTION ELIGIBLE</Typography><Typography fontWeight={900} color="warning.main">NO</Typography></Box>
          </Stack>
        </CardContent></Card>

        <Grid container spacing={2}>
          <Grid size={{ xs: 12, md: 6, xl: 4 }}><LaneCard title="MA BASELINE" subtitle="Pattern + MA20/50/200" metrics={result.maBaseline.metrics} /></Grid>
          {result.variants.map((variant) => <Grid key={variant.name} size={{ xs: 12, md: 6, xl: 4 }}><LaneCard title={variant.name} subtitle={variant.name === "DUAL_STATE" ? "M15 + M5 đang cùng hướng" : `Fresh flip · accepted signals ${variant.acceptedSignals}`} metrics={variant.metrics} highlight={variant.name === result.decision.preferredResearchLane} /></Grid>)}
        </Grid>

        <Card variant="outlined"><CardContent>
          <Typography variant="subtitle1" fontWeight={900}>Signal funnel</Typography>
          <Grid container spacing={1.5} sx={{ mt: .5 }}>
            {[
              ["Pattern raw", result.signalDiagnostics.patternSignals],
              ["M15 đúng hướng", result.signalDiagnostics.m15Aligned],
              ["Dual state", result.signalDiagnostics.dualStateAligned],
              ["M5/M15 bất đồng", result.signalDiagnostics.timeframeDisagreement],
              ["Flip ≤1 bar", result.signalDiagnostics.flip1Signals],
              ["Flip ≤2 bars", result.signalDiagnostics.flip2Signals],
              ["Flip ≤3 bars", result.signalDiagnostics.flip3Signals],
            ].map(([label, value]) => <Grid key={String(label)} size={{ xs: 6, md: 3 }}><Typography variant="caption" color="text.secondary">{label}</Typography><Typography variant="h6" fontWeight={800}>{value}</Typography></Grid>)}
          </Grid>
        </CardContent></Card>

        {preferred && <>
          <Typography variant="h6" fontWeight={900}>Breakdown · {preferred.name}</Typography>
          <VariantBreakdown variant={preferred} />
        </>}
      </>}
    </Stack>
  );
}
