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
import { runPhase7DDailyScaleBacktest } from "../phase7d-daily-scale-api";
import type {
  Phase7DDailyScaleLane,
  Phase7DDailyScaleMetrics,
  Phase7DDailyScaleResult,
  Phase7DReconciliationCheck,
} from "../phase7d-daily-scale-types";

const DAY_MS = 86_400_000;
function isoDate(date: Date) { return date.toISOString().slice(0, 10); }
function money(value: number) { return `${value >= 0 ? "+" : "−"}$${Math.abs(value).toFixed(2)}`; }
function pf(value: number | null) { return value === null ? "∞" : value.toFixed(2); }
function initialRange() {
  const to = new Date();
  return { from: isoDate(new Date(to.getTime() - 89 * DAY_MS)), to: isoDate(to) };
}

export function Phase7DDailyScalePage() {
  const range = initialRange();
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [fixedVolume, setFixedVolume] = useState(0.03);
  const [recoveryMinPrice, setRecoveryMinPrice] = useState(6);
  const [recoveryMaxPrice, setRecoveryMaxPrice] = useState(10);
  const [profitBufferUsd, setProfitBufferUsd] = useState(3);
  const [positiveLockFloorUsd, setPositiveLockFloorUsd] = useState(0);
  const [result, setResult] = useState<Phase7DDailyScaleResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function preset(days: number) {
    const end = new Date();
    setFrom(isoDate(new Date(end.getTime() - Math.max(0, days - 1) * DAY_MS)));
    setTo(isoDate(end));
    setResult(null);
  }

  async function run(event: React.FormEvent) {
    event.preventDefault();
    setRunning(true);
    setError(null);
    try {
      setResult(await runPhase7DDailyScaleBacktest({
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
      setError(err instanceof Error ? err.message : "Daily scale research failed.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="overline" color="primary" fontWeight={800}>PHASE 7D · DAILY MANAGEMENT RESEARCH</Typography>
        <Typography variant="h5" fontWeight={900}>Recovery + Positive Lock + 10/20 Scale Optimizer</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Ngày âm: full-close động 6–10 giá để phục hồi. Ngày dương: Positive Lock, +10 chốt 1/3, +20 chốt thêm 1/3, 1/3 cuối gồng trend.
        </Typography>
      </Box>

      <Alert severity="warning">
        Research only. Không thay đổi Phase 7B DEMO. Mọi verdict BE6/BE10 hiện bị khóa nếu Reconciliation Gate không PASS trên đúng cùng khoảng dữ liệu.
      </Alert>

      <Card><CardContent component="form" onSubmit={run}>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
          {[30, 90, 180, 365].map((days) => <Button key={days} size="small" variant="outlined" onClick={() => preset(days)}>{days} ngày</Button>)}
        </Stack>
        <Grid container spacing={2}>
          <Grid size={{ xs: 12, md: 3 }}><TextField fullWidth size="small" type="date" label="Từ ngày" value={from} onChange={(e) => setFrom(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} /></Grid>
          <Grid size={{ xs: 12, md: 3 }}><TextField fullWidth size="small" type="date" label="Đến ngày" value={to} onChange={(e) => setTo(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} /></Grid>
          <Grid size={{ xs: 6, md: 1.5 }}><TextField fullWidth size="small" type="number" label="Fixed lot" value={fixedVolume} onChange={(e) => setFixedVolume(Number(e.target.value))} slotProps={{ htmlInput: { min: 0.03, step: 0.03 } }} /></Grid>
          <Grid size={{ xs: 6, md: 1.5 }}><TextField fullWidth size="small" type="number" label="Recovery min" value={recoveryMinPrice} onChange={(e) => setRecoveryMinPrice(Number(e.target.value))} /></Grid>
          <Grid size={{ xs: 6, md: 1.5 }}><TextField fullWidth size="small" type="number" label="Recovery max" value={recoveryMaxPrice} onChange={(e) => setRecoveryMaxPrice(Number(e.target.value))} /></Grid>
          <Grid size={{ xs: 6, md: 1.5 }}><TextField fullWidth size="small" type="number" label="Buffer $" value={profitBufferUsd} onChange={(e) => setProfitBufferUsd(Number(e.target.value))} /></Grid>
          <Grid size={{ xs: 6, md: 2 }}><TextField fullWidth size="small" type="number" label="Positive Lock floor $" value={positiveLockFloorUsd} onChange={(e) => setPositiveLockFloorUsd(Number(e.target.value))} /></Grid>
          <Grid size={{ xs: 12, md: 2 }}><Button fullWidth type="submit" variant="contained" startIcon={<PlayArrowRounded />} disabled={running} sx={{ height: 40 }}>{running ? "Đang reconcile..." : "Reconcile + đánh giá"}</Button></Grid>
        </Grid>
      </CardContent></Card>

      {error ? <Alert severity="error">{error}</Alert> : null}
      {result ? <ResultView result={result} /> : null}
    </Stack>
  );
}

function ResultView({ result }: { result: Phase7DDailyScaleResult }) {
  const lanes = [
    ["CURRENT · Phase 7B", result.current],
    ["RECOVERY + LOCK · current trend", result.recoveryLockCurrent],
    ["RECOVERY + LOCK · +10/+20 · BE6", result.scaleBe6],
    ["RECOVERY + LOCK · +10/+20 · BE10", result.scaleBe10],
  ] as const;

  return <Stack spacing={2}>
    <ReconciliationCard result={result} />

    <Card><CardContent>
      <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" gap={2}>
        <Box>
          <Typography variant="overline" color="text.secondary" fontWeight={800}>DAILY SCALE RESEARCH DECISION</Typography>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="h5" fontWeight={900}>{result.decision.verdict.replaceAll("_", " ")}</Typography>
            <Chip variant="outlined" label={`${result.decision.sampleTrades} candidates · ${result.decision.sampleDays} days`} />
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{result.decision.reason}</Typography>
        </Box>
        <Box>
          <Typography variant="caption" color="text.secondary">Preferred research lane</Typography>
          <Typography fontWeight={900}>{result.decision.preferredResearchLane.replaceAll("_", " ")}</Typography>
          <Typography variant="caption" color="warning.main">EXECUTION ELIGIBLE = NO</Typography>
        </Box>
      </Stack>
    </CardContent></Card>

    <Alert severity="info">
      Volume map: +10 đóng {result.configuration.firstPartialVolume.toFixed(2)} lot · +20 đóng {result.configuration.secondPartialVolume.toFixed(2)} lot · runner {result.configuration.finalRunnerVolume.toFixed(2)} lot. Broker step {result.configuration.volumeStep}.
    </Alert>

    <Grid container spacing={2}>
      {lanes.map(([title, lane]) => <Grid key={lane.lane} size={{ xs: 12, md: 6 }}><LaneCard title={title} lane={lane} /></Grid>)}
    </Grid>

    <Card><CardContent>
      <Typography fontWeight={900}>So sánh tổng hợp</Typography>
      <TableContainer sx={{ mt: 1 }}><Table size="small">
        <TableHead><TableRow>
          <TableCell>Lane</TableCell><TableCell align="right">Trades</TableCell><TableCell align="right">Block</TableCell><TableCell align="right">Ngày +</TableCell><TableCell align="right">Net</TableCell><TableCell align="right">PF</TableCell><TableCell align="right">Exp.</TableCell><TableCell align="right">Max DD</TableCell><TableCell align="right">+10</TableCell><TableCell align="right">+20</TableCell><TableCell align="right">BE&lt;10</TableCell>
        </TableRow></TableHead>
        <TableBody>{lanes.map(([title, lane]) => <MetricsRow key={lane.lane} label={title} metrics={lane.metrics} />)}</TableBody>
      </Table></TableContainer>
    </CardContent></Card>

    <Grid container spacing={2}>
      <Grid size={{ xs: 12, lg: 6 }}><PnlBreakdown title="+10/+20 SCALE · BE6" metrics={result.scaleBe6.metrics} /></Grid>
      <Grid size={{ xs: 12, lg: 6 }}><PnlBreakdown title="+10/+20 SCALE · BE10" metrics={result.scaleBe10.metrics} /></Grid>
    </Grid>

    {result.reconciliation.passed ? <Card><CardContent>
      <Typography fontWeight={900}>Điểm nghiên cứu so với Recovery + Lock hiện tại</Typography>
      <Grid container spacing={2} sx={{ mt: 0.5 }}>
        {result.decision.candidates.map((item) => <Grid key={item.lane} size={{ xs: 12, md: 6 }}>
          <Box sx={{ border: "1px solid rgba(148,163,184,.12)", borderRadius: 2, p: 1.5 }}>
            <Stack direction="row" justifyContent="space-between"><Typography fontWeight={900}>{item.lane.replaceAll("_", " ")}</Typography><Chip label={`${item.score}/100`} size="small" /></Stack>
            <Typography variant="body2" sx={{ mt: 1 }}>Δ Net {money(item.deltas.netPnl)} · Δ PF {item.deltas.profitFactor === null ? "—" : item.deltas.profitFactor.toFixed(3)} · Δ DD {money(item.deltas.maxDrawdownUsd)}</Typography>
            <Typography variant="body2">Δ ngày dương {item.deltas.positiveDayRatePercent >= 0 ? "+" : ""}{item.deltas.positiveDayRatePercent.toFixed(2)} pp · Δ Exp {money(item.deltas.expectancy)}/trade</Typography>
          </Box>
        </Grid>)}
      </Grid>
    </CardContent></Card> : <Alert severity="error">Không chấm BE6/BE10 vì baseline chưa reconcile. Dùng bảng Reconciliation Gate ở trên để xác định engine nào đang lệch.</Alert>}

    {result.notes.map((note) => <Alert key={note} severity="info">{note}</Alert>)}
  </Stack>;
}

function ReconciliationCard({ result }: { result: Phase7DDailyScaleResult }) {
  const r = result.reconciliation;
  return <Card sx={{ border: `1px solid ${r.passed ? "rgba(46,204,113,.35)" : "rgba(244,67,54,.35)"}` }}><CardContent>
    <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" gap={2}>
      <Box>
        <Typography variant="overline" color="text.secondary" fontWeight={800}>RECONCILIATION GATE</Typography>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography variant="h6" fontWeight={900}>{r.status}</Typography>
          <Chip size="small" color={r.passed ? "success" : "error"} label={r.passed ? "DECISION UNLOCKED" : "DECISION LOCKED"} />
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{r.note}</Typography>
      </Box>
      <Box>
        <Typography variant="caption" color="text.secondary">Failed checks</Typography>
        <Typography fontWeight={900}>{r.failedKeys.length ? r.failedKeys.length : 0}</Typography>
      </Box>
    </Stack>
    <TableContainer sx={{ mt: 1.5 }}><Table size="small">
      <TableHead><TableRow><TableCell>Check</TableCell><TableCell>Status</TableCell><TableCell align="right">Expected</TableCell><TableCell align="right">Actual</TableCell><TableCell align="right">Delta</TableCell></TableRow></TableHead>
      <TableBody>{r.checks.map((check) => <ReconciliationRow key={check.key} check={check} />)}</TableBody>
    </Table></TableContainer>
  </CardContent></Card>;
}

function ReconciliationRow({ check }: { check: Phase7DReconciliationCheck }) {
  const value = (input: number | string | null) => input === null ? "—" : typeof input === "number" ? input.toFixed(4).replace(/\.0000$/, "") : input;
  return <TableRow>
    <TableCell sx={{ fontFamily: "monospace", fontSize: 12 }}>{check.key}</TableCell>
    <TableCell><Chip size="small" color={check.pass ? "success" : "error"} variant="outlined" label={check.pass ? "PASS" : "FAIL"} /></TableCell>
    <TableCell align="right">{value(check.expected)}</TableCell>
    <TableCell align="right">{value(check.actual)}</TableCell>
    <TableCell align="right">{check.delta === null ? "—" : check.delta.toFixed(4)}</TableCell>
  </TableRow>;
}

function LaneCard({ title, lane }: { title: string; lane: Phase7DDailyScaleLane }) {
  const m = lane.metrics;
  return <Card sx={{ height: "100%" }}><CardContent>
    <Typography fontWeight={900}>{title}</Typography>
    <Grid container spacing={1.3} sx={{ mt: 0.5 }}>
      <Stat label="Ngày dương" value={`${m.positiveDayRatePercent.toFixed(1)}%`} good={m.positiveDayRatePercent >= 60} />
      <Stat label="Net P/L" value={money(m.netPnl)} good={m.netPnl > 0} />
      <Stat label="PF" value={pf(m.profitFactor)} good={(m.profitFactor ?? 0) >= 1} />
      <Stat label="Max DD" value={`$${m.maxDrawdownUsd.toFixed(2)}`} />
      <Stat label="Recovery" value={`${m.recoveredDays} days · ${m.recoveryTpHits} TP`} />
      <Stat label="Trades / Block" value={`${m.trades} / ${m.blockedTrades}`} />
      <Stat label="Chạm +10 / +20" value={`${m.plus10RatePercent.toFixed(1)}% / ${m.plus20RatePercent.toFixed(1)}%`} />
      <Stat label="BE stop trước +10" value={`${m.beStopsBefore10}`} />
    </Grid>
  </CardContent></Card>;
}

function PnlBreakdown({ title, metrics: m }: { title: string; metrics: Phase7DDailyScaleMetrics }) {
  return <Card><CardContent>
    <Typography fontWeight={900}>{title} · P/L breakdown</Typography>
    <Grid container spacing={1.5} sx={{ mt: 0.5 }}>
      <Stat label="Realized @ +10" value={money(m.firstPartialPnl)} good={m.firstPartialPnl > 0} />
      <Stat label="Realized @ +20" value={money(m.secondPartialPnl)} good={m.secondPartialPnl > 0} />
      <Stat label="Runner P/L" value={money(m.runnerPnl)} good={m.runnerPnl > 0} />
      <Stat label="Average daily" value={money(m.averageDailyPnl)} good={m.averageDailyPnl > 0} />
      <Stat label="Worst day" value={money(m.worstDayUsd)} />
      <Stat label="Recovery trades" value={`${m.recoveryTrades}`} />
    </Grid>
  </CardContent></Card>;
}

function MetricsRow({ label, metrics: m }: { label: string; metrics: Phase7DDailyScaleMetrics }) {
  return <TableRow>
    <TableCell>{label}</TableCell><TableCell align="right">{m.trades}</TableCell><TableCell align="right">{m.blockedTrades}</TableCell><TableCell align="right">{m.positiveDayRatePercent.toFixed(1)}%</TableCell><TableCell align="right">{money(m.netPnl)}</TableCell><TableCell align="right">{pf(m.profitFactor)}</TableCell><TableCell align="right">{money(m.expectancy)}</TableCell><TableCell align="right">${m.maxDrawdownUsd.toFixed(2)}</TableCell><TableCell align="right">{m.plus10RatePercent.toFixed(1)}%</TableCell><TableCell align="right">{m.plus20RatePercent.toFixed(1)}%</TableCell><TableCell align="right">{m.beStopsBefore10}</TableCell>
  </TableRow>;
}

function Stat({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return <Grid size={{ xs: 6 }}><Box sx={{ border: "1px solid rgba(148,163,184,.12)", borderRadius: 2, p: 1.2 }}><Typography variant="caption" color="text.secondary">{label}</Typography><Typography fontWeight={900} color={good === true ? "success.main" : "text.primary"}>{value}</Typography></Box></Grid>;
}
