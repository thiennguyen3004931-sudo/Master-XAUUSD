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
import { runPhase7DManagementBacktest } from "../phase7d-management-api";
import type {
  Phase7DManagementMetrics,
  Phase7DManagementResult,
  Phase7DManagementVariant,
} from "../phase7d-management-types";

const DAY_MS = 86_400_000;

function isoDate(date: Date) { return date.toISOString().slice(0, 10); }
function initialRange() {
  const to = new Date();
  const from = new Date(to.getTime() - 89 * DAY_MS);
  return { from: isoDate(from), to: isoDate(to) };
}
function money(value: number) { return `${value >= 0 ? "+" : "−"}$${Math.abs(value).toFixed(2)}`; }
function pf(value: number | null) { return value === null ? "∞" : value.toFixed(2); }

export function Phase7DManagementPage() {
  const range = initialRange();
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [fixedVolume, setFixedVolume] = useState(0.03);
  const [result, setResult] = useState<Phase7DManagementResult | null>(null);
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
      setResult(await runPhase7DManagementBacktest({ from, to, fixedVolume }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Management research failed.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="overline" color="primary" fontWeight={800}>PHASE 7D · MANAGEMENT RESEARCH</Typography>
        <Typography variant="h5" fontWeight={900}>BE + Partial Optimizer</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Đo chính xác trade-off giữa +6 dời SL về Entry và giữ SL gốc đến +10. Entry signal, MA, SL cấu trúc và runner logic giữ nguyên.
        </Typography>
      </Box>

      <Alert severity="warning">
        Research only. Không thay đổi Phase 7B DEMO. Với 0.03 lot và volumeStep 0.01, chốt đúng 1/2 = 0.015 lot không thực thi được; lane 1/2 chỉ để tham khảo lý thuyết.
      </Alert>

      <Card>
        <CardContent component="form" onSubmit={run}>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
            {[30, 90, 180, 365].map((days) => (
              <Button key={days} type="button" size="small" variant="outlined" onClick={() => preset(days)}>{days} ngày</Button>
            ))}
          </Stack>
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, sm: 4 }}><TextField fullWidth size="small" type="date" label="Từ ngày" value={from} onChange={(e) => setFrom(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} /></Grid>
            <Grid size={{ xs: 12, sm: 4 }}><TextField fullWidth size="small" type="date" label="Đến ngày" value={to} onChange={(e) => setTo(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} /></Grid>
            <Grid size={{ xs: 12, sm: 2 }}><TextField fullWidth size="small" type="number" label="Fixed lot" value={fixedVolume} onChange={(e) => setFixedVolume(Number(e.target.value))} slotProps={{ htmlInput: { min: 0.01, step: 0.01 } }} /></Grid>
            <Grid size={{ xs: 12, sm: 2 }}>
              <Button fullWidth type="submit" variant="contained" startIcon={<PlayArrowRounded />} disabled={running} sx={{ height: 40 }}>
                {running ? "Đang replay..." : "So sánh"}
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

function ResultView({ result }: { result: Phase7DManagementResult }) {
  const current = result.variants.find((item) => item.name === "CURRENT_BE6_PARTIAL_THIRD")!;
  const delayed = result.variants.find((item) => item.name === "BE10_PARTIAL_THIRD")!;
  const half = result.variants.find((item) => item.name === "BE10_PARTIAL_HALF_THEORETICAL")!;
  const d = result.decision.deltaBe10ThirdVsCurrent;

  return (
    <Stack spacing={2}>
      <Card>
        <CardContent>
          <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" gap={2}>
            <Box>
              <Typography variant="overline" color="text.secondary" fontWeight={800}>MANAGEMENT RESEARCH DECISION</Typography>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                <Typography variant="h5" fontWeight={900}>{result.decision.verdict.replaceAll("_", " ")}</Typography>
                <Chip variant="outlined" label={`${result.signals} signals`} />
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{result.decision.reason}</Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">Preferred executable research variant</Typography>
              <Typography fontWeight={900}>{result.decision.preferredExecutableResearchVariant.replaceAll("_", " ")}</Typography>
              <Typography variant="caption" color="warning.main">EXECUTION ELIGIBLE = NO</Typography>
            </Box>
          </Stack>
        </CardContent>
      </Card>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, lg: 4 }}><VariantCard title="CURRENT · +6 BE · +10 1/3" variant={current} /></Grid>
        <Grid size={{ xs: 12, lg: 4 }}><VariantCard title="+10 BE · +10 1/3" variant={delayed} /></Grid>
        <Grid size={{ xs: 12, lg: 4 }}><VariantCard title="+10 BE · +10 1/2" variant={half} /></Grid>
      </Grid>

      <Card>
        <CardContent>
          <Typography fontWeight={900}>So sánh +10 BE + 1/3 so với hiện tại</Typography>
          <Grid container spacing={2} sx={{ mt: 0.5 }}>
            <Delta label="Δ Net P/L" value={money(d.netPnl)} good={d.netPnl > 0} />
            <Delta label="Δ Win rate" value={`${d.winRatePercent >= 0 ? "+" : ""}${d.winRatePercent.toFixed(2)} pp`} good={d.winRatePercent > 0} />
            <Delta label="Δ PF" value={d.profitFactor === null ? "—" : `${d.profitFactor >= 0 ? "+" : ""}${d.profitFactor.toFixed(3)}`} good={(d.profitFactor ?? 0) > 0} />
            <Delta label="Δ Expectancy" value={`${d.expectancy >= 0 ? "+" : ""}$${d.expectancy.toFixed(2)}/trade`} good={d.expectancy > 0} />
            <Delta label="Δ Max DD" value={money(d.maxDrawdownUsd)} good={d.maxDrawdownUsd < 0} />
            <Delta label="BE bị đá trước +10 tránh được" value={`${d.beStopsAvoidedBefore10}`} good={d.beStopsAvoidedBefore10 > 0} />
            <Delta label="Full SL thêm sau khi từng +6" value={`${d.extraFullStopsAfterPlus6}`} good={d.extraFullStopsAfterPlus6 <= 0} />
            <Delta label="Δ tỷ lệ chạm +10" value={`${d.plus10RatePercent >= 0 ? "+" : ""}${d.plus10RatePercent.toFixed(2)} pp`} good={d.plus10RatePercent > 0} />
          </Grid>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography fontWeight={900}>Bảng tổng hợp</Typography>
          <TableContainer sx={{ mt: 1 }}>
            <Table size="small">
              <TableHead><TableRow>
                <TableCell>Variant</TableCell><TableCell align="right">Trades</TableCell><TableCell align="right">Win %</TableCell><TableCell align="right">Net</TableCell><TableCell align="right">PF</TableCell><TableCell align="right">Exp.</TableCell><TableCell align="right">Max DD</TableCell><TableCell align="right">+10 rate</TableCell><TableCell align="right">BE stop &lt;10</TableCell><TableCell align="right">+6 rồi full SL</TableCell>
              </TableRow></TableHead>
              <TableBody>
                <MetricsRow label="Current +6 BE / 1/3" metrics={current.metrics} />
                <MetricsRow label="+10 BE / 1/3" metrics={delayed.metrics} />
                <MetricsRow label="+10 BE / 1/2 theoretical" metrics={half.metrics} />
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>

      <Alert severity={half.config.executableWithBrokerStep ? "success" : "info"}>
        1/2 theoretical: partial {half.config.partialVolumeAtFixedLot.toFixed(3)} lot, runner {half.config.runnerVolumeAtFixedLot.toFixed(3)} lot. Broker step {result.broker.volumeStep}. {half.config.executableWithBrokerStep ? "Có thể thực thi với lot này." : "Không thể thực thi chính xác với fixed lot hiện tại."}
      </Alert>

      {result.notes.map((note) => <Alert key={note} severity="info">{note}</Alert>)}
    </Stack>
  );
}

function VariantCard({ title, variant }: { title: string; variant: Phase7DManagementVariant }) {
  const m = variant.metrics;
  return (
    <Card sx={{ height: "100%" }}><CardContent>
      <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
        <Typography fontWeight={900}>{title}</Typography>
        <Chip size="small" color={variant.config.executableWithBrokerStep ? "success" : "warning"} variant="outlined" label={variant.config.executableWithBrokerStep ? "EXECUTABLE" : "THEORETICAL"} />
      </Stack>
      <Grid container spacing={1.5} sx={{ mt: 0.5 }}>
        <Stat label="Net P/L" value={money(m.netPnl)} good={m.netPnl > 0} />
        <Stat label="PF" value={pf(m.profitFactor)} good={(m.profitFactor ?? 0) >= 1} />
        <Stat label="Win rate" value={`${m.winRatePercent.toFixed(1)}%`} />
        <Stat label="Max DD" value={`$${m.maxDrawdownUsd.toFixed(2)}`} good={false} />
        <Stat label="Chạm +10" value={`${m.plus10RatePercent.toFixed(1)}%`} />
        <Stat label="BE stop trước +10" value={`${m.beStopBeforePlus10} (${m.beStopBeforePlus10RatePercent.toFixed(1)}%)`} />
        <Stat label="+6 rồi full SL" value={`${m.plus6ThenFullStopBefore10} (${m.plus6ThenFullStopBefore10RatePercent.toFixed(1)}%)`} />
        <Stat label="Partial / runner" value={`${variant.config.partialVolumeAtFixedLot.toFixed(3)} / ${variant.config.runnerVolumeAtFixedLot.toFixed(3)}`} />
      </Grid>
    </CardContent></Card>
  );
}

function Stat({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return <Grid size={{ xs: 6 }}><Box sx={{ border: "1px solid rgba(148,163,184,.12)", borderRadius: 2, p: 1.2 }}><Typography variant="caption" color="text.secondary">{label}</Typography><Typography fontWeight={900} color={good === true ? "success.main" : good === false ? "error.main" : "text.primary"}>{value}</Typography></Box></Grid>;
}
function Delta({ label, value, good }: { label: string; value: string; good: boolean }) {
  return <Grid size={{ xs: 12, sm: 6, md: 3 }}><Box sx={{ border: "1px solid rgba(148,163,184,.12)", borderRadius: 2, p: 1.4 }}><Typography variant="caption" color="text.secondary">{label}</Typography><Typography fontWeight={900} color={good ? "success.main" : "warning.main"}>{value}</Typography></Box></Grid>;
}
function MetricsRow({ label, metrics: m }: { label: string; metrics: Phase7DManagementMetrics }) {
  return <TableRow><TableCell>{label}</TableCell><TableCell align="right">{m.trades}</TableCell><TableCell align="right">{m.winRatePercent.toFixed(1)}%</TableCell><TableCell align="right">{money(m.netPnl)}</TableCell><TableCell align="right">{pf(m.profitFactor)}</TableCell><TableCell align="right">{money(m.expectancy)}</TableCell><TableCell align="right">${m.maxDrawdownUsd.toFixed(2)}</TableCell><TableCell align="right">{m.plus10RatePercent.toFixed(1)}%</TableCell><TableCell align="right">{m.beStopBeforePlus10}</TableCell><TableCell align="right">{m.plus6ThenFullStopBefore10}</TableCell></TableRow>;
}
