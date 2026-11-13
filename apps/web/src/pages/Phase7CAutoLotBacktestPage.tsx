import { useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Grid,
  LinearProgress,
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
import { runPhase7CAutoLotBacktest } from "../api";
import type { Phase7CAutoLotBacktestResult } from "../phase7c-auto-lot-types";
import { MetricCard } from "../ui/MetricCard";

const DAY_MS = 24 * 60 * 60_000;

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function initialRange() {
  const to = new Date();
  const from = new Date(to.getTime() - 89 * DAY_MS);
  return { from: isoDate(from), to: isoDate(to) };
}

function money(value: number) {
  return `${value >= 0 ? "+" : "−"}$${Math.abs(value).toFixed(2)}`;
}

function pf(value: number | null) {
  return value === null ? "∞" : value.toFixed(2);
}

function verdictColor(verdict: Phase7CAutoLotBacktestResult["decision"]["verdict"]) {
  if (verdict === "SHADOW_PROMISING") return "success" as const;
  if (verdict === "REJECT_AUTO_LOT") return "error" as const;
  if (verdict === "KEEP_FIXED") return "warning" as const;
  return "info" as const;
}

function verdictLabel(verdict: Phase7CAutoLotBacktestResult["decision"]["verdict"]) {
  switch (verdict) {
    case "SHADOW_PROMISING": return "SHADOW PROMISING";
    case "REJECT_AUTO_LOT": return "REJECT AUTO LOT";
    case "KEEP_FIXED": return "KEEP FIXED";
    case "NEEDS_MORE_DATA": return "NEEDS MORE DATA";
    default: return "INSUFFICIENT SAMPLE";
  }
}

function csvEscape(value: unknown) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportShadowCsv(result: Phase7CAutoLotBacktestResult) {
  const header = [
    "entryTime",
    "side",
    "pattern",
    "stopDistance",
    "fixedLot",
    "fixedPnl",
    "balanceBefore",
    "targetRiskUsd",
    "rawLot",
    "autoLot",
    "autoRiskUsd",
    "autoRiskPercent",
    "autoPnl",
    "balanceAfter",
    "status",
    "reason",
  ];
  const rows = result.shadowTrades.map((trade) => [
    new Date(trade.entryTime).toISOString(),
    trade.side,
    trade.pattern,
    trade.stopDistance,
    trade.fixedLot,
    trade.fixedPnl,
    trade.balanceBefore,
    trade.targetRiskUsd,
    trade.rawLot,
    trade.autoLot,
    trade.autoRiskUsd,
    trade.autoRiskPercent,
    trade.autoPnl,
    trade.balanceAfter,
    trade.status,
    trade.reason,
  ]);
  const csv = [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `phase7c-auto-lot-shadow-${result.backtest.range.from}-${result.backtest.range.to}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function Phase7CAutoLotBacktestPage() {
  const range = initialRange();
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [fixedVolume, setFixedVolume] = useState(0.03);
  const [riskPercent, setRiskPercent] = useState(0.05);
  const [maxAutoLot, setMaxAutoLot] = useState(0.09);
  const [startingBalance, setStartingBalance] = useState(0);
  const [result, setResult] = useState<Phase7CAutoLotBacktestResult | null>(null);
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
      setResult(await runPhase7CAutoLotBacktest({
        from,
        to,
        fixedVolume,
        riskPercent,
        maxAutoLot,
        startingBalance: startingBalance > 0 ? startingBalance : undefined,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Auto Lot comparison failed.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <Stack spacing={2}>
      <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" gap={2}>
        <Box>
          <Typography variant="overline" color="primary" fontWeight={800}>PHASE 7C · SIZING RESEARCH</Typography>
          <Typography variant="h5" fontWeight={900}>Auto Lot SHADOW vs Fixed</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            So sánh sizing theo % balance với fixed lot trên cùng Canonical Phase 7B trade schedule. Không thay đổi lệnh DEMO đang chạy.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Chip color="warning" label="SHADOW ONLY" />
          <Chip variant="outlined" label="EXECUTION MUTATION = FALSE" />
          <Chip variant="outlined" label="1/3 MANAGEMENT COMPATIBLE" />
        </Stack>
      </Stack>

      <Alert severity="info">
        Auto Lot chỉ được chọn kích thước lot mà broker có thể chốt <b>đúng 1/3</b> tại +10 và vẫn còn runner. Nếu risk target không đủ cho một lot tương thích, trade SHADOW sẽ <b>BLOCK</b> thay vì đổi rule quản lý.
      </Alert>

      <Card>
        <CardContent component="form" onSubmit={run}>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
            {[7, 30, 90, 180, 365].map((days) => (
              <Button key={days} type="button" size="small" variant="outlined" onClick={() => preset(days)}>{days} ngày</Button>
            ))}
          </Stack>
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, sm: 6, md: 2 }}><TextField fullWidth size="small" type="date" label="Từ ngày" value={from} onChange={(e) => setFrom(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} /></Grid>
            <Grid size={{ xs: 12, sm: 6, md: 2 }}><TextField fullWidth size="small" type="date" label="Đến ngày" value={to} onChange={(e) => setTo(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} /></Grid>
            <Grid size={{ xs: 12, sm: 6, md: 2 }}><TextField fullWidth size="small" type="number" label="Fixed lot" value={fixedVolume} onChange={(e) => setFixedVolume(Number(e.target.value))} slotProps={{ htmlInput: { min: 0.03, step: 0.03 } }} /></Grid>
            <Grid size={{ xs: 12, sm: 6, md: 2 }}><TextField fullWidth size="small" type="number" label="Risk / trade (%)" value={riskPercent} onChange={(e) => setRiskPercent(Number(e.target.value))} slotProps={{ htmlInput: { min: 0.01, max: 5, step: 0.01 } }} /></Grid>
            <Grid size={{ xs: 12, sm: 6, md: 2 }}><TextField fullWidth size="small" type="number" label="Max Auto Lot" value={maxAutoLot} onChange={(e) => setMaxAutoLot(Number(e.target.value))} slotProps={{ htmlInput: { min: 0.03, step: 0.03 } }} /></Grid>
            <Grid size={{ xs: 12, sm: 6, md: 2 }}><TextField fullWidth size="small" type="number" label="Starting balance" value={startingBalance} onChange={(e) => setStartingBalance(Number(e.target.value))} helperText="0 = MT5 hiện tại" slotProps={{ htmlInput: { min: 0, step: 100 } }} /></Grid>
            <Grid size={{ xs: 12 }}>
              <Button type="submit" variant="contained" startIcon={<PlayArrowRounded />} disabled={running}>
                {running ? "Đang replay + tính Auto Lot..." : "So sánh Auto Lot vs Fixed"}
              </Button>
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      {error ? <Alert severity="error">{error}</Alert> : null}
      {result ? <Comparison result={result} /> : null}
    </Stack>
  );
}

function Comparison({ result }: { result: Phase7CAutoLotBacktestResult }) {
  const f = result.fixed;
  const a = result.autoLot;
  const d = result.deltaAutoMinusFixed;
  const decision = result.decision;
  return (
    <Stack spacing={2}>
      <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" gap={1}>
        <Box>
          <Typography fontWeight={900}>{result.backtest.range.from} → {result.backtest.range.to}</Typography>
          <Typography variant="caption" color="text.secondary">
            Start {money(result.configuration.startingBalance)} · {result.configuration.startingBalanceSource} · risk {result.configuration.riskPercent}% · cap {result.configuration.maxAutoLot.toFixed(2)} lot
          </Typography>
        </Box>
        <Button size="small" variant="outlined" onClick={() => exportShadowCsv(result)} disabled={result.shadowTrades.length === 0}>Xuất Shadow CSV</Button>
      </Stack>

      <Card>
        <CardContent>
          <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" gap={2} alignItems={{ md: "center" }}>
            <Box sx={{ flex: 1 }}>
              <Typography variant="overline" color="text.secondary" fontWeight={800}>AUTO LOT RESEARCH DECISION</Typography>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                <Typography variant="h4" fontWeight={900}>{decision.score}/{decision.maxScore}</Typography>
                <Chip color={verdictColor(decision.verdict)} label={verdictLabel(decision.verdict)} />
                <Chip variant="outlined" label={`${decision.sampleTrades}/${decision.minimumSampleTrades} min trades`} />
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{decision.reason}</Typography>
            </Box>
            <Box sx={{ minWidth: { md: 260 } }}>
              <Typography variant="caption" color="text.secondary">Research score</Typography>
              <LinearProgress variant="determinate" value={decision.score} sx={{ height: 10, borderRadius: 5, mt: .5 }} />
              <Typography variant="caption" color="warning.main" sx={{ display: "block", mt: 1 }}>
                EXECUTION ELIGIBLE = NO
              </Typography>
            </Box>
          </Stack>

          <TableContainer sx={{ mt: 2 }}>
            <Table size="small">
              <TableHead><TableRow><TableCell>Tiêu chí</TableCell><TableCell>Status</TableCell><TableCell align="right">Điểm</TableCell><TableCell>Chi tiết</TableCell></TableRow></TableHead>
              <TableBody>
                {decision.criteria.map((criterion) => (
                  <TableRow key={criterion.key}>
                    <TableCell><b>{criterion.label}</b></TableCell>
                    <TableCell><Chip size="small" color={criterion.pass ? "success" : "warning"} variant="outlined" label={criterion.pass ? "PASS" : "WATCH"} /></TableCell>
                    <TableCell align="right">{criterion.score}/{criterion.maxScore}</TableCell>
                    <TableCell>{criterion.detail}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>

      {result.configuration.journalTradeLimitApplied ? (
        <Alert severity="warning">
          Full-period có {result.configuration.fullPeriodCanonicalTrades} trades nhưng comparison hiện dùng {result.configuration.comparedTradeSchedule} trades journal gần nhất. Fixed và Auto vẫn được so trên cùng schedule, nhưng verdict không đại diện toàn bộ kỳ.
        </Alert>
      ) : null}

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, sm: 6, xl: 3 }}><MetricCard label="AUTO Net P/L" value={money(a.netPnl)} detail={`Fixed ${money(f.netPnl)} · Δ ${money(d.netPnl)}`} tone={a.netPnl >= 0 ? "success.main" : "error.main"} /></Grid>
        <Grid size={{ xs: 12, sm: 6, xl: 3 }}><MetricCard label="AUTO Max DD" value={`$${a.maxDrawdownUsd.toFixed(2)}`} detail={`Fixed $${f.maxDrawdownUsd.toFixed(2)} · Δ ${money(d.maxDrawdownUsd)}`} tone="error.main" /></Grid>
        <Grid size={{ xs: 12, sm: 6, xl: 3 }}><MetricCard label="AUTO Ending Balance" value={`$${a.endingBalance.toFixed(2)}`} detail={`Fixed $${f.endingBalance.toFixed(2)} · Δ ${money(d.endingBalance)}`} /></Grid>
        <Grid size={{ xs: 12, sm: 6, xl: 3 }}><MetricCard label="AUTO Lot" value={`${a.averageLot.toFixed(2)} avg`} detail={`min ${a.minLot.toFixed(2)} · max ${a.maxLot.toFixed(2)}`} /></Grid>
      </Grid>

      <Card><CardContent>
        <Typography fontWeight={900}>Fixed vs Auto Lot SHADOW</Typography>
        <Table size="small" sx={{ mt: 1 }}>
          <TableHead><TableRow><TableCell>Lane</TableCell><TableCell align="right">Trades</TableCell><TableCell align="right">Win %</TableCell><TableCell align="right">Net P/L</TableCell><TableCell align="right">PF</TableCell><TableCell align="right">Expectancy</TableCell><TableCell align="right">Max DD</TableCell><TableCell align="right">Ending</TableCell></TableRow></TableHead>
          <TableBody>
            <TableRow><TableCell>Fixed {result.configuration.fixedVolume.toFixed(2)}</TableCell><TableCell align="right">{f.trades}</TableCell><TableCell align="right">{f.winRatePercent.toFixed(1)}%</TableCell><TableCell align="right">{money(f.netPnl)}</TableCell><TableCell align="right">{pf(f.profitFactor)}</TableCell><TableCell align="right">{money(f.expectancy)}</TableCell><TableCell align="right">${f.maxDrawdownUsd.toFixed(2)}</TableCell><TableCell align="right">${f.endingBalance.toFixed(2)}</TableCell></TableRow>
            <TableRow><TableCell><b>Auto Lot SHADOW</b></TableCell><TableCell align="right">{a.executedTrades}/{a.attemptedTrades}</TableCell><TableCell align="right">{a.winRatePercent.toFixed(1)}%</TableCell><TableCell align="right"><b>{money(a.netPnl)}</b></TableCell><TableCell align="right">{pf(a.profitFactor)}</TableCell><TableCell align="right">{money(a.expectancy)}</TableCell><TableCell align="right">${a.maxDrawdownUsd.toFixed(2)}</TableCell><TableCell align="right"><b>${a.endingBalance.toFixed(2)}</b></TableCell></TableRow>
          </TableBody>
        </Table>
      </CardContent></Card>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, sm: 6, xl: 3 }}><MetricCard label="Executed / Blocked" value={`${a.executedTrades} / ${a.blockedTrades}`} detail={`${a.blockRatePercent.toFixed(2)}% blocked`} /></Grid>
        <Grid size={{ xs: 12, sm: 6, xl: 3 }}><MetricCard label="Avg actual risk" value={money(a.averageRiskUsd)} detail={`${a.averageRiskPercent.toFixed(4)}% balance`} /></Grid>
        <Grid size={{ xs: 12, sm: 6, xl: 3 }}><MetricCard label="Risk stability" value={`${a.riskStdDevPercent.toFixed(4)} pp`} detail="StdDev actual risk %" /></Grid>
        <Grid size={{ xs: 12, sm: 6, xl: 3 }}><MetricCard label="Avg target risk" value={money(a.averageTargetRiskUsd)} detail={`Configured ${result.configuration.riskPercent}%`} /></Grid>
      </Grid>

      <Card><CardContent>
        <Typography fontWeight={900}>Sizing Journal</Typography>
        <TableContainer sx={{ mt: 1, maxHeight: 520 }}>
          <Table size="small" stickyHeader>
            <TableHead><TableRow><TableCell>Entry</TableCell><TableCell>Side</TableCell><TableCell>Pattern</TableCell><TableCell align="right">SL</TableCell><TableCell align="right">Balance</TableCell><TableCell align="right">Target $</TableCell><TableCell align="right">Raw lot</TableCell><TableCell align="right">Auto lot</TableCell><TableCell align="right">Risk $</TableCell><TableCell align="right">P/L</TableCell><TableCell>Status</TableCell></TableRow></TableHead>
            <TableBody>
              {result.shadowTrades.map((trade, index) => (
                <TableRow key={`${trade.entryTime}-${index}`}>
                  <TableCell sx={{ whiteSpace: "nowrap" }}>{new Date(trade.entryTime).toLocaleString("vi-VN")}</TableCell>
                  <TableCell><Chip size="small" color={trade.side === "BUY" ? "success" : "error"} variant="outlined" label={trade.side} /></TableCell>
                  <TableCell>{trade.pattern === "TWO_CANDLE_BODY_DOMINANCE" ? "TWO-CANDLE" : trade.pattern}</TableCell>
                  <TableCell align="right">{trade.stopDistance.toFixed(2)}</TableCell>
                  <TableCell align="right">${trade.balanceBefore.toFixed(2)}</TableCell>
                  <TableCell align="right">${trade.targetRiskUsd.toFixed(2)}</TableCell>
                  <TableCell align="right">{trade.rawLot.toFixed(3)}</TableCell>
                  <TableCell align="right"><b>{trade.autoLot.toFixed(2)}</b></TableCell>
                  <TableCell align="right">${trade.autoRiskUsd.toFixed(2)}</TableCell>
                  <TableCell align="right" sx={{ color: trade.autoPnl >= 0 ? "success.main" : "error.main", fontWeight: 800 }}>{money(trade.autoPnl)}</TableCell>
                  <TableCell><Chip size="small" color={trade.status === "EXECUTE" ? "success" : "warning"} variant="outlined" label={trade.status} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </CardContent></Card>

      {result.notes.map((note) => <Alert key={note} severity="info">{note}</Alert>)}
    </Stack>
  );
}
