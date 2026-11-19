import type { ReactNode } from "react";
import {
  Box,
  Card,
  CardContent,
  Grid,
  Stack,
  Typography,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import {
  boolText,
  clean,
  fetchPhase7CWebStatus,
  money,
  pickText,
  raw,
  value,
} from "../phase7c-panel-status";

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function Row({ label, valueText }: { label: string; valueText: string }) {
  return (
    <Stack direction="row" justifyContent="space-between" gap={2} py={0.7}>
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Typography variant="body2" fontWeight={850} textAlign="right">{valueText}</Typography>
    </Stack>
  );
}

function DiagnosticCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <Card variant="outlined" sx={{ borderRadius: 3, height: "100%" }}>
      <CardContent sx={{ p: 2.2 }}>
        <Typography fontWeight={950}>{title}</Typography>
        <Typography variant="caption" color="text.secondary">{subtitle}</Typography>
        <Box mt={1.2}>{children}</Box>
      </CardContent>
    </Card>
  );
}

export function Phase7CAccountRiskAdvancedPanel() {
  const query = useQuery({
    queryKey: ["phase7c-web-status-account-risk-v6"],
    queryFn: fetchPhase7CWebStatus,
    refetchInterval: 3_000,
    retry: false,
    placeholderData: (previous) => previous,
  });

  const data = query.data;
  const panel = data?.panel;
  const accountRisk = asRecord(data?.accountRisk);
  const account = asRecord(accountRisk.account);
  const configuration = asRecord(accountRisk.configuration);
  const quote = asRecord(accountRisk.quote);
  const spec = asRecord(accountRisk.spec);
  const lifecycle = asRecord(data?.lifecycle);
  const bridge = asRecord(lifecycle.bridge);
  const processes = asRecord(lifecycle.processes);
  const supervisor = asRecord(processes.supervisor);
  const trend = asRecord(processes.trend);
  const sideway = asRecord(processes.sideway);
  const telegram = asRecord(processes.telegram);
  const notifier = asRecord(processes.regimeNotifier);
  const mode = asRecord(lifecycle.mode);
  const activeMode = clean(data?.ui?.mode, clean(mode.mode, value(panel, "activeMode", "—")));
  const currency = clean(account.accountCurrency, "USD");

  if (query.isLoading && !data) {
    return <Typography color="text.secondary">Đang đọc chẩn đoán…</Typography>;
  }
  if (query.isError && !data) {
    return (
      <Typography color="error">
        Không đọc được chẩn đoán: {query.error instanceof Error ? query.error.message : "lỗi không xác định"}
      </Typography>
    );
  }

  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, lg: 4 }}>
        <DiagnosticCard title="Runtime & Bridge" subtitle="Trạng thái nền Phase7C">
          <Row label="Lifecycle running" valueText={boolText(lifecycle.running)} />
          <Row label="Lifecycle ready" valueText={boolText(lifecycle.ready)} />
          <Row label="Active mode" valueText={activeMode} />
          <Row label="Bridge" valueText={bridge.reachable ? "OK" : "CHECK"} />
          <Row label="Trading enabled" valueText={boolText(account.tradingEnabled ?? bridge.tradingEnabled)} />
          <Row label="XAUUSD positions" valueText={pickText(bridge.openXauusdPositions, raw(panel, "positionCount"), "0")} />
        </DiagnosticCard>
      </Grid>

      <Grid size={{ xs: 12, lg: 4 }}>
        <DiagnosticCard title="Executors" subtitle="Process telemetry">
          <Row label="Supervisor" valueText={supervisor.alive ? `Alive · PID ${clean(supervisor.pid, "—")}` : "CHECK"} />
          <Row label="Trend" valueText={trend.alive ? `Alive · PID ${clean(trend.pid, "—")}` : "CHECK"} />
          <Row label="Sideway" valueText={sideway.alive ? `Alive · PID ${clean(sideway.pid, "—")}` : "CHECK"} />
          <Row label="Telegram" valueText={telegram.alive ? `Alive · PID ${clean(telegram.pid, "—")}` : "CHECK"} />
          <Row label="Regime notifier" valueText={notifier.alive ? `Alive · PID ${clean(notifier.pid, "—")}` : "CHECK"} />
        </DiagnosticCard>
      </Grid>

      <Grid size={{ xs: 12, lg: 4 }}>
        <DiagnosticCard title="Broker / Safety" subtitle="Thông tin kỹ thuật read-only">
          <Row label="Bid / Ask" valueText={`${clean(quote.bid, "—")} / ${clean(quote.ask, "—")}`} />
          <Row label="Spread" valueText={clean(quote.spread, "—")} />
          <Row label="Broker symbol" valueText={clean(spec.brokerSymbol, "XAUUSD")} />
          <Row label="Volume step" valueText={clean(spec.volumeStep, "—")} />
          <Row label="Balance" valueText={money(account.accountBalance, currency)} />
          <Row label="Order permission" valueText={pickText(configuration.previewOrderPermission, data?.ui?.safety?.orderPermission, raw(panel, "mt5OrderPermission"), "NONE")} />
        </DiagnosticCard>
      </Grid>
    </Grid>
  );
}
