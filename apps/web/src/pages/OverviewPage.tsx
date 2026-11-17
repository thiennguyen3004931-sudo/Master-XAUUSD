import { Box, Card, CardContent, Grid, LinearProgress, Stack, Typography } from "@mui/material";
import AccountBalanceWalletRounded from "@mui/icons-material/AccountBalanceWalletRounded";
import TrendingUpRounded from "@mui/icons-material/TrendingUpRounded";
import ShieldRounded from "@mui/icons-material/ShieldRounded";
import { useDashboard } from "../hooks";
import { ErrorState, LoadingState } from "../ui/PageState";
import { MetricCard } from "../ui/MetricCard";
import { Sparkline } from "../ui/Sparkline";
import { StatusChip } from "../ui/StatusChip";
import { money, percent, price } from "../format";

export function OverviewPage() {
  const query = useDashboard();
  if (query.isLoading) return <LoadingState />;
  if (!query.data) return <ErrorState message={query.error instanceof Error ? query.error.message : "Không có dữ liệu dashboard."} />;
  const data = query.data;
  const account = data.account;

  return (
    <Stack spacing={2}>
      <Card>
        <CardContent>
          <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" gap={3}>
            <Box>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                <Typography color="primary" variant="overline" fontWeight={800}>{data.market.symbol}</Typography>
                <StatusChip value={data.control.mode} />
                <StatusChip value={data.market.session} />
              </Stack>
              <Stack direction="row" spacing={4} alignItems="end" sx={{ mt: 2 }}>
                <Box>
                  <Typography variant="caption" color="text.secondary">Bid</Typography>
                  <Typography variant="h2" fontWeight={800} sx={{ letterSpacing: "-.05em" }}>{price(data.market.bid)}</Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">Ask</Typography>
                  <Typography variant="h5" fontWeight={700}>{price(data.market.ask)}</Typography>
                </Box>
              </Stack>
              <Stack direction="row" spacing={3} flexWrap="wrap" sx={{ mt: 2 }}>
                <Typography variant="caption" color="text.secondary">Spread {price(data.market.spread)}</Typography>
                <Typography variant="caption" color="text.secondary">ATR {price(data.market.atr)}</Typography>
                <Typography variant="caption" color="text.secondary">Trend {data.analysis.trend}</Typography>
                <Typography variant="caption" color="text.secondary">Structure {data.analysis.structure}</Typography>
              </Stack>
            </Box>
            <Box className="guard-card">
              <Typography variant="subtitle2" fontWeight={800}>Execution guard</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1, maxWidth: 310, lineHeight: 1.6 }}>
                Runtime API chỉ chạy phân tích trong SHADOW/DEMO. Không gọi Pack 08 hoặc MT5 live từ Dashboard.
              </Typography>
            </Box>
          </Stack>
        </CardContent>
      </Card>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, sm: 6, xl: 3 }}><MetricCard label="Equity" value={money(account.equity, account.currency)} detail={`Balance ${money(account.balance, account.currency)}`} icon={<AccountBalanceWalletRounded color="primary" />} /></Grid>
        <Grid size={{ xs: 12, sm: 6, xl: 3 }}><MetricCard label="P&L hôm nay" value={money(account.dailyPnl, account.currency)} detail={`Floating ${money(account.floatingPnl, account.currency)}`} icon={<TrendingUpRounded color="success" />} tone={account.dailyPnl >= 0 ? "success.main" : "error.main"} /></Grid>
        <Grid size={{ xs: 12, sm: 6, xl: 3 }}><MetricCard label="Signal" value={`${data.signal.direction} · ${data.signal.confidence.toFixed(1)}%`} detail={`R:R ${data.signal.riskReward?.toFixed(2) ?? "—"}`} icon={<TrendingUpRounded color="primary" />} /></Grid>
        <Grid size={{ xs: 12, sm: 6, xl: 3 }}><MetricCard label="Open risk" value={percent(data.risk.openRiskPercent)} detail={`Limit ${percent(data.risk.maxOpenRiskPercent)}`} icon={<ShieldRounded color="success" />} /></Grid>
      </Grid>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, xl: 4 }}>
          <Card sx={{ height: "100%" }}><CardContent>
            <Stack direction="row" justifyContent="space-between"><Typography fontWeight={800}>Signal Engine</Typography><StatusChip value={data.signal.direction} /></Stack>
            <Grid container spacing={1.5} sx={{ mt: .5 }}>
              {[["Entry", price(data.signal.entry)], ["SL", price(data.signal.stopLoss)], ["TP", price(data.signal.takeProfit)], ["R:R", data.signal.riskReward?.toFixed(2) ?? "—"]].map(([label, value]) => (
                <Grid size={6} key={label}><Box className="mini-card"><Typography variant="caption" color="text.secondary">{label}</Typography><Typography fontWeight={800}>{value}</Typography></Box></Grid>
              ))}
            </Grid>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 2 }}>Confidence</Typography>
            <LinearProgress variant="determinate" value={Math.min(100, data.signal.confidence)} sx={{ mt: 1, height: 6, borderRadius: 10 }} />
            <Stack spacing={1} sx={{ mt: 2 }}>{data.signal.reasons.slice(0, 3).map((reason) => <Typography key={reason} variant="caption" color="text.secondary">• {reason}</Typography>)}</Stack>
          </CardContent></Card>
        </Grid>
        <Grid size={{ xs: 12, xl: 4 }}>
          <Card sx={{ height: "100%" }}><CardContent>
            <Stack direction="row" justifyContent="space-between"><Typography fontWeight={800}>Risk Engine</Typography><StatusChip value={data.risk.approved ? "APPROVED" : "BLOCKED"} /></Stack>
            <Stack spacing={2.2} sx={{ mt: 2 }}>
              <RiskLine label="Open risk" value={data.risk.openRiskPercent} max={data.risk.maxOpenRiskPercent} />
              <RiskLine label="Daily loss" value={data.risk.dailyLossPercent} max={data.risk.maxDailyLossPercent} />
              <RiskLine label="Drawdown" value={data.risk.drawdownPercent} max={data.risk.maxDrawdownPercent} />
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 2 }}>Position {data.risk.positionSize.toFixed(2)} lot · Risk {money(data.risk.riskAmount)}</Typography>
          </CardContent></Card>
        </Grid>
        <Grid size={{ xs: 12, xl: 4 }}>
          <Card sx={{ height: "100%" }}><CardContent>
            <Stack direction="row" justifyContent="space-between"><Typography fontWeight={800}>AI Review</Typography><StatusChip value={data.ai.action} /></Stack>
            <Stack direction="row" justifyContent="space-between" alignItems="end" sx={{ mt: 2 }}>
              <Box><Typography variant="caption" color="text.secondary">Confidence</Typography><Typography variant="h4" fontWeight={800}>{data.ai.confidence.toFixed(1)}%</Typography></Box>
              <Box textAlign="right"><Typography variant="caption" color="text.secondary">Agreement</Typography><Typography fontWeight={800}>{(data.ai.agreementRatio * 100).toFixed(0)}%</Typography></Box>
            </Stack>
            <Stack spacing={1} sx={{ mt: 2 }}>{data.ai.reasons.slice(0, 3).map((reason) => <Typography key={reason} variant="caption" color="text.secondary">• {reason}</Typography>)}</Stack>
          </CardContent></Card>
        </Grid>
      </Grid>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, xl: 8 }}><Card><CardContent><Typography fontWeight={800}>Equity curve</Typography><Box sx={{ mt: 2 }}><Sparkline values={data.equityCurve.map((point) => point.equity)} positive={(data.equityCurve.at(-1)?.equity ?? 0) >= (data.equityCurve[0]?.equity ?? 0)} /></Box></CardContent></Card></Grid>
        <Grid size={{ xs: 12, xl: 4 }}><Card sx={{ height: "100%" }}><CardContent><Typography fontWeight={800}>Strategy</Typography><Stack spacing={1.5} sx={{ mt: 2 }}><Info label="Action" value={data.strategy.action} /><Info label="Module" value={data.strategy.strategyId ?? "—"} /><Info label="Regime" value={`${data.strategy.regime} · ${data.strategy.regimeConfidence.toFixed(1)}%`} /><Info label="Analysis score" value={data.analysis.score.toFixed(1)} /></Stack></CardContent></Card></Grid>
      </Grid>
    </Stack>
  );
}

function RiskLine({ label, value, max }: { label: string; value: number; max: number }) {
  return <Box><Stack direction="row" justifyContent="space-between"><Typography variant="caption" color="text.secondary">{label}</Typography><Typography variant="caption">{percent(value)} / {percent(max)}</Typography></Stack><LinearProgress color={max > 0 && value / max > .8 ? "error" : "success"} variant="determinate" value={max > 0 ? Math.min(100, value / max * 100) : 0} sx={{ mt: 1, height: 6, borderRadius: 10 }} /></Box>;
}
function Info({ label, value }: { label: string; value: string }) { return <Stack direction="row" justifyContent="space-between" gap={2}><Typography variant="caption" color="text.secondary">{label}</Typography><Typography variant="caption" fontWeight={800} textAlign="right">{value}</Typography></Stack>; }
