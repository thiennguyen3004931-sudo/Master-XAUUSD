import { useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Grid,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import PlayArrowRounded from "@mui/icons-material/PlayArrowRounded";
import { runPhase7DDailyPnlBacktest } from "../api";
import type {
  Phase7DDailyPnlResult,
  Phase7DLaneMetrics,
  Phase7DLaneResult,
} from "../phase7d-types";
import { MetricCard } from "../ui/MetricCard";

const DAY_MS = 86_400_000;

function isoDate(date: Date) { return date.toISOString().slice(0, 10); }
function initialRange() {
  const to = new Date();
  const from = new Date(to.getTime() - 89 * DAY_MS);
  return { from: isoDate(from), to: isoDate(to) };
}
function money(value: number) { return `${value >= 0 ? "+" : "−"}$${Math.abs(value).toFixed(2)}`; }
function pf(value: number | null) { return value === null ? "∞" : value.toFixed(2); }

export function Phase7DDailyPnlPage() {
  const range = initialRange();
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [fixedVolume, setFixedVolume] = useState(0.03);
  const [recoveryMinPrice, setRecoveryMinPrice] = useState(6);
  const [recoveryMaxPrice, setRecoveryMaxPrice] = useState(10);
  const [profitBufferUsd, setProfitBufferUsd] = useState(3);
  const [positiveLockFloorUsd, setPositiveLockFloorUsd] = useState(0);
  const [result, setResult] = useState<Phase7DDailyPnlResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function preset(days: number) {
    const end = new Date();
    const start = new Date(end.getTime() - Math.max(0, days - 1) * DAY_MS);
    setFrom(isoDate(start));
    setTo(isoDate(end));
    setResult(null);
  }

  async function run(event: React.FormEvent) {
    event.preventDefault();
    setRunning(true);
    setError(null);
    try {
      setResult(await runPhase7DDailyPnlBacktest({
        from,
        to,
        fixedVolume,
        recoveryMinPrice,
        recoveryMaxPrice,
        profitBufferUsd,
        positiveLockFloorUsd,
        dayUtcOffsetHours: 7,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Daily P/L research failed.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <Stack spacing={2}>
      <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" gap={2}>
        <Box>
          <Typography variant="overline" color="primary" fontWeight={800}>PHASE 7D.2 · LOCK ISOLATION</Typography>
          <Typography variant="h5" fontWeight={900}>Daily P/L Optimizer</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Exact per-lane signal replay: Baseline · Recovery 6–10 · Trend + Positive Lock · Recovery + Positive Lock.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
          <Chip color="warning" label="RESEARCH ONLY" />
          <Chip variant="outlined" label="EXACT PER-LANE SIGNAL REPLAY" />
          <Chip variant="outlined" label="EXECUTION = OFF" />
        </Stack>
      </Stack>

      <Alert severity="warning">
        Mục tiêu là <b>tăng tỷ lệ ngày kết thúc dương</b>, không phải cam kết mọi ngày đều lãi. Phase 7B DEMO không bị thay đổi.
      </Alert>

      <Card>
        <CardContent component="form" onSubmit={run}>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
            {[30, 90, 180, 365].map((days) => (
              <Button key={days} type="button" size="small" variant="outlined" onClick={() => preset(days)}>{days} ngày</Button>
            ))}
          </Stack>
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, sm: 6, md: 2 }}><TextField fullWidth size="small" type="date" label="Từ ngày" value={from} onChange={(e) => setFrom(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} /></Grid>
            <Grid size={{ xs: 12, sm: 6, md: 2 }}><TextField fullWidth size="small" type="date" label="Đến ngày" value={to} onChange={(e) => setTo(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} /></Grid>
            <Grid size={{ xs: 12, sm: 6, md: 2 }}><TextField fullWidth size="small" type="number" label="Fixed lot" value={fixedVolume} onChange={(e) => setFixedVolume(Number(e.target.value))} slotProps={{ htmlInput: { min: 0.01, step: 0.01 } }} /></Grid>
            <Grid size={{ xs: 12, sm: 6, md: 2 }}><TextField fullWidth size="small" type="number" label="Recovery min (giá)" value={recoveryMinPrice} onChange={(e) => setRecoveryMinPrice(Number(e.target.value))} slotProps={{ htmlInput: { min: 1, step: 0.5 } }} /></Grid>
            <Grid size={{ xs: 12, sm: 6, md: 2 }}><TextField fullWidth size="small" type="number" label="Recovery max (giá)" value={recoveryMaxPrice} onChange={(e) => setRecoveryMaxPrice(Number(e.target.value))} slotProps={{ htmlInput: { min: 1, step: 0.5 } }} /></Grid>
            <Grid size={{ xs: 12, sm: 6, md: 2 }}><TextField fullWidth size="small" type="number" label="Profit buffer ($)" value={profitBufferUsd} onChange={(e) => setProfitBufferUsd(Number(e.target.value))} slotProps={{ htmlInput: { min: 0, step: 1 } }} /></Grid>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}><TextField fullWidth size="small" type="number" label="Positive Lock floor ($)" value={positiveLockFloorUsd} onChange={(e) => setPositiveLockFloorUsd(Number(e.target.value))} helperText="0 = bảo vệ ngày không rơi về âm" slotProps={{ htmlInput: { min: 0, step: 1 } }} /></Grid>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <Button fullWidth type="submit" variant="contained" startIcon={<PlayArrowRounded />} disabled={running} sx={{ height: 40 }}>
                {running ? "Đang replay 4 phương án..." : "Đánh giá 4 phương án"}
              </Button>
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      {error ? <Alert severity="error">{error}</Alert> : null}
      {result ? <ResultView result={result} /> : null}
    </Stack>
  );
}

function ResultView({ result }: { result: Phase7DDailyPnlResult }) {
  const decision = result.decision;
  const verdictColor = decision.verdict === "RESEARCH_PROMISING" ? "success" : decision.verdict === "INSUFFICIENT_SAMPLE" ? "warning" : "error";

  return (
    <Stack spacing={2}>
      <Card>
        <CardContent>
          <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" gap={2}>
            <Box>
              <Typography variant="overline" color="text.secondary" fontWeight={800}>DAILY P/L RESEARCH DECISION</Typography>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                <Typography variant="h4" fontWeight={900}>{decision.bestResearchScore}/100</Typography>
                <Chip color={verdictColor} label={decision.verdict.replaceAll("_", " ")} />
                <Chip variant="outlined" label={`${decision.sampleTrades} candidates · ${decision.sampleDays} days`} />
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{decision.reason}</Typography>
            </Box>
            <Box sx={{ minWidth: 280 }}>
              <Typography variant="caption" color="text.secondary">Recommended research lane</Typography>
              <Typography fontWeight={900}>{decision.recommendedLane.replaceAll("_", " ")}</Typography>
              <Typography variant="caption" color="warning.main">EXECUTION ELIGIBLE = NO</Typography>
            </Box>
          </Stack>
        </CardContent>
      </Card>

      <Alert severity="info">
        <b>Lock isolation:</b> {decision.lockIsolation.interpretation}
      </Alert>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 6, xl: 3 }}><LaneCard title="BASELINE" lane={result.baseline} /></Grid>
        <Grid size={{ xs: 12, md: 6, xl: 3 }}><LaneCard title="RECOVERY 6–10" lane={result.recovery} /></Grid>
        <Grid size={{ xs: 12, md: 6, xl: 3 }}><LaneCard title="TREND + LOCK" lane={result.trendPlusLock} /></Grid>
        <Grid size={{ xs: 12, md: 6, xl: 3 }}><LaneCard title="RECOVERY + LOCK" lane={result.recoveryPlusLock} /></Grid>
      </Grid>

      <Card>
        <CardContent>
          <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" gap={1}>
            <Box>
              <Typography fontWeight={900}>So sánh tổng hợp</Typography>
              <Typography variant="caption" color="text.secondary">Signals {result.configuration.signals} · filled candidates {result.configuration.filledCandidateTrades}</Typography>
            </Box>
            <Typography variant="caption" color="text.secondary">
              Busy skips: Base {result.configuration.baselineSkippedPositionBusy} · Recovery {result.configuration.recoverySkippedPositionBusy} · Trend+Lock {result.configuration.trendPlusLockSkippedPositionBusy} · Recovery+Lock {result.configuration.recoveryPlusLockSkippedPositionBusy}
            </Typography>
          </Stack>
          <TableContainer sx={{ mt: 1 }}>
            <Table size="small">
              <TableHead><TableRow>
                <TableCell>Lane</TableCell><TableCell align="right">Trades</TableCell><TableCell align="right">Blocked</TableCell><TableCell align="right">Ngày dương</TableCell><TableCell align="right">Net P/L</TableCell><TableCell align="right">PF</TableCell><TableCell align="right">Expectancy</TableCell><TableCell align="right">Max DD</TableCell><TableCell align="right">Worst day</TableCell><TableCell align="right">Losing streak</TableCell>
              </TableRow></TableHead>
              <TableBody>
                <LaneRow label="Baseline" metrics={result.baseline.metrics} />
                <LaneRow label="Recovery" metrics={result.recovery.metrics} />
                <LaneRow label="Trend + Lock" metrics={result.trendPlusLock.metrics} />
                <LaneRow label="Recovery + Lock" metrics={result.recoveryPlusLock.metrics} />
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, lg: 6 }}><LockDiagnostics title="TREND + LOCK · BLOCK DIAGNOSTICS" metrics={result.trendPlusLock.metrics} /></Grid>
        <Grid size={{ xs: 12, lg: 6 }}><LockDiagnostics title="RECOVERY + LOCK · BLOCK DIAGNOSTICS" metrics={result.recoveryPlusLock.metrics} /></Grid>
      </Grid>

      <Grid container spacing={2}>
        {decision.candidates.map((candidate) => (
          <Grid key={candidate.lane} size={{ xs: 12, md: 4 }}>
            <Card sx={{ height: "100%" }}><CardContent>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography fontWeight={900}>{candidate.lane.replaceAll("_", " ")}</Typography>
                <Chip label={`${candidate.score}/100`} />
              </Stack>
              <Stack spacing={0.8} sx={{ mt: 2 }}>
                <Typography>Δ ngày dương: <b>{candidate.deltas.positiveDayRatePercent >= 0 ? "+" : ""}{candidate.deltas.positiveDayRatePercent.toFixed(2)} pp</b></Typography>
                <Typography>Δ Net P/L: <b>{money(candidate.deltas.netPnl)}</b></Typography>
                <Typography>Δ PF: <b>{candidate.deltas.profitFactor === null ? "—" : candidate.deltas.profitFactor.toFixed(3)}</b></Typography>
                <Typography>Δ Max DD: <b>{money(candidate.deltas.maxDrawdownUsd)}</b></Typography>
                <Typography>Δ Worst day: <b>{money(candidate.deltas.worstDayUsd)}</b></Typography>
              </Stack>
            </CardContent></Card>
          </Grid>
        ))}
      </Grid>

      <Card><CardContent>
        <Typography fontWeight={900}>Daily result · Recovery + Lock</Typography>
        <Typography variant="caption" color="text.secondary">Tối đa 370 ngày; ngày tính theo UTC+7.</Typography>
        <TableContainer sx={{ mt: 1, maxHeight: 460 }}>
          <Table size="small" stickyHeader>
            <TableHead><TableRow><TableCell>Ngày</TableCell><TableCell align="right">P/L</TableCell><TableCell align="right">Trades</TableCell><TableCell align="right">Recovery</TableCell><TableCell align="right">Blocked</TableCell><TableCell>Status</TableCell></TableRow></TableHead>
            <TableBody>{result.recoveryPlusLock.days.map((day) => (
              <TableRow key={day.day}>
                <TableCell>{day.day}</TableCell>
                <TableCell align="right" sx={{ fontWeight: 800, color: day.pnl >= 0 ? "success.main" : "error.main" }}>{money(day.pnl)}</TableCell>
                <TableCell align="right">{day.trades}</TableCell><TableCell align="right">{day.recoveryTrades}</TableCell><TableCell align="right">{day.blocked}</TableCell>
                <TableCell><Chip size="small" color={day.pnl > 0 ? "success" : day.pnl < 0 ? "error" : "default"} variant="outlined" label={day.recoveredFromNegative ? "RECOVERED +" : day.pnl > 0 ? "POSITIVE" : day.pnl < 0 ? "NEGATIVE" : "FLAT"} /></TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        </TableContainer>
      </CardContent></Card>

      {result.notes.map((note) => <Alert key={note} severity="info">{note}</Alert>)}
    </Stack>
  );
}

function LaneCard({ title, lane }: { title: string; lane: Phase7DLaneResult }) {
  const m = lane.metrics;
  return (
    <Card sx={{ height: "100%" }}><CardContent>
      <Typography fontWeight={900}>{title}</Typography>
      <Grid container spacing={1.5} sx={{ mt: 0.5 }}>
        <Grid size={{ xs: 6 }}><MetricCard label="Ngày dương" value={`${m.positiveDayRatePercent.toFixed(1)}%`} detail={`${m.positiveDays}/${m.activeDays} ngày`} /></Grid>
        <Grid size={{ xs: 6 }}><MetricCard label="Net P/L" value={money(m.netPnl)} detail={`PF ${pf(m.profitFactor)}`} tone={m.netPnl >= 0 ? "success.main" : "error.main"} /></Grid>
        <Grid size={{ xs: 6 }}><MetricCard label="Max DD" value={`$${m.maxDrawdownUsd.toFixed(2)}`} detail={`Worst ${money(m.worstDayUsd)}`} tone="error.main" /></Grid>
        <Grid size={{ xs: 6 }}><MetricCard label="Trades / Block" value={`${m.trades} / ${m.blockedTrades}`} detail={`busy skip ${m.skippedPositionBusy}`} /></Grid>
      </Grid>
    </CardContent></Card>
  );
}

function LockDiagnostics({ title, metrics: m }: { title: string; metrics: Phase7DLaneMetrics }) {
  return (
    <Card sx={{ height: "100%" }}><CardContent>
      <Typography fontWeight={900}>{title}</Typography>
      <Typography variant="caption" color="text.secondary">Isolated canonical outcome của các candidate bị Lock chặn; không phải full alternate-path replay.</Typography>
      <Grid container spacing={1.5} sx={{ mt: 0.5 }}>
        <Grid size={{ xs: 6 }}><MetricCard label="Blocked" value={`${m.positiveLockBlockedTrades}`} detail={`${m.positiveLockBlockedDays} ngày`} /></Grid>
        <Grid size={{ xs: 6 }}><MetricCard label="Blocked winner %" value={`${m.blockedCounterfactualWinRatePercent.toFixed(1)}%`} detail={`PF ${pf(m.blockedCounterfactualProfitFactor)}`} /></Grid>
        <Grid size={{ xs: 6 }}><MetricCard label="Blocked canonical P/L" value={money(m.blockedCounterfactualNetPnl)} detail={`GP ${money(m.blockedCounterfactualGrossProfit)} · GL −$${m.blockedCounterfactualGrossLoss.toFixed(2)}`} tone={m.blockedCounterfactualNetPnl <= 0 ? "success.main" : "warning.main"} /></Grid>
        <Grid size={{ xs: 6 }}><MetricCard label="Estimated P/L saved" value={money(m.lockEstimatedPnlSavedUsd)} detail={`Initial risk avoided $${m.blockedInitialRiskUsd.toFixed(2)}`} tone={m.lockEstimatedPnlSavedUsd >= 0 ? "success.main" : "warning.main"} /></Grid>
      </Grid>
    </CardContent></Card>
  );
}

function LaneRow({ label, metrics: m }: { label: string; metrics: Phase7DLaneMetrics }) {
  return <TableRow>
    <TableCell><b>{label}</b></TableCell><TableCell align="right">{m.trades}</TableCell><TableCell align="right">{m.blockedTrades}</TableCell><TableCell align="right">{m.positiveDayRatePercent.toFixed(1)}%</TableCell><TableCell align="right" sx={{ color: m.netPnl >= 0 ? "success.main" : "error.main", fontWeight: 800 }}>{money(m.netPnl)}</TableCell><TableCell align="right">{pf(m.profitFactor)}</TableCell><TableCell align="right">{money(m.expectancy)}</TableCell><TableCell align="right">${m.maxDrawdownUsd.toFixed(2)}</TableCell><TableCell align="right">{money(m.worstDayUsd)}</TableCell><TableCell align="right">{m.maxConsecutiveLosingDays}</TableCell>
  </TableRow>;
}
