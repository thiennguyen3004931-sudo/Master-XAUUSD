import {
  Alert,
  Box,
  Card,
  CardContent,
  Chip,
  Grid,
  Stack,
  Typography,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import {
  clean,
  compactReason,
  fetchPhase7CWebStatus,
  getTradeUiState,
  raw,
  value,
} from "../phase7c-panel-status";
import { ErrorState, LoadingState } from "../ui/PageState";
import { Phase7CMobileM4ControlCard } from "../ui/Phase7CMobileM4ControlCard";
import { Phase7COperatorStatusBar } from "../ui/Phase7COperatorStatusBar";

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function MobileCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card
      variant="outlined"
      sx={{
        height: "100%",
        borderRadius: 3,
        bgcolor: "rgba(7,14,25,.74)",
        borderColor: "rgba(148,163,184,.14)",
      }}
    >
      <CardContent sx={{ p: { xs: 1.5, sm: 1.8 }, "&:last-child": { pb: { xs: 1.5, sm: 1.8 } } }}>
        <Typography variant="overline" color="text.secondary" fontWeight={950}>
          {title}
        </Typography>
        <Box mt={0.8}>{children}</Box>
      </CardContent>
    </Card>
  );
}

function MobileMetric({ label, valueText, tone = "default" }: { label: string; valueText: string; tone?: "default" | "success" | "warning" | "error" | "info" }) {
  const color = tone === "success"
    ? "success.main"
    : tone === "warning"
      ? "warning.main"
      : tone === "error"
        ? "error.main"
        : tone === "info"
          ? "info.main"
          : "text.primary";

  return (
    <Stack
      direction="row"
      justifyContent="space-between"
      gap={1.5}
      py={0.8}
      sx={{ borderBottom: "1px solid rgba(148,163,184,.08)" }}
    >
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Typography variant="body2" fontWeight={950} color={color} textAlign="right" sx={{ overflowWrap: "anywhere" }}>
        {valueText}
      </Typography>
    </Stack>
  );
}

function stateLabel(state: "WAITING" | "SETUP_READY" | "MANAGING") {
  if (state === "SETUP_READY") return "SETUP ĐÃ ĐƯỢC DUYỆT";
  if (state === "MANAGING") return "ĐANG QUẢN LÝ LỆNH";
  return "ĐANG CHỜ TÍN HIỆU";
}

export function Phase7CMobileReadOnlyPage() {
  const query = useQuery({
    queryKey: ["phase7c-mobile-readonly-m1"],
    queryFn: fetchPhase7CWebStatus,
    refetchInterval: 3_000,
    retry: false,
    placeholderData: (previous) => previous,
  });

  if (query.isLoading) return <LoadingState />;
  if (query.isError && !query.data) {
    return <ErrorState message={query.error instanceof Error ? query.error.message : "Không đọc được trạng thái Phase7C."} />;
  }

  const data = query.data;
  const panel = data?.panel;
  const ui = data?.ui;
  const accountRisk = asRecord(data?.accountRisk);
  const quote = asRecord(accountRisk.quote);

  const uiState = getTradeUiState(panel, ui);
  const activeMode = clean(ui?.mode, value(panel, "activeMode", "—"));
  const strategy = clean(ui?.effectiveStrategy, value(panel, "effectiveStrategy", "—"));
  const regime = clean(ui?.regime, value(panel, "regime", "—"));
  const confidence = clean(ui?.confidence, value(panel, "confidence", "—"));
  const recommendedMode = clean(ui?.recommendedMode, value(panel, "recommendedMode", "—"));
  const setup = ui?.setup;
  const position = ui?.position;

  const fallbackWaitReasons = compactReason(
    [raw(panel, "limitReason"), raw(panel, "decisionReason"), raw(panel, "entryReason")].filter(Boolean).join(" | "),
    "Chưa có setup hợp lệ.",
  );
  const waitReasons = ui?.reasons.wait?.length ? ui.reasons.wait : fallbackWaitReasons;
  const entryReasons = ui?.reasons.entry?.length
    ? ui.reasons.entry
    : compactReason(raw(panel, "entryReason") || raw(panel, "decisionReason"), "Engine chưa trả lý do setup.");
  const holdReasons = ui?.reasons.hold?.length
    ? ui.reasons.hold
    : compactReason(raw(panel, "holdReason"), "Engine chưa trả lý do giữ lệnh.");
  const currentReasons = uiState === "WAITING" ? waitReasons : uiState === "SETUP_READY" ? entryReasons : holdReasons;

  return (
    <Stack spacing={{ xs: 1.25, sm: 1.6 }}>
      <Box
        sx={{
          p: { xs: 1.5, sm: 1.8 },
          borderRadius: 3,
          border: "1px solid rgba(0,213,255,.18)",
          bgcolor: "rgba(3,10,18,.86)",
        }}
      >
        <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" gap={1.2} alignItems={{ sm: "center" }}>
          <Box>
            <Typography variant="h5" fontWeight={950}>XAUUSD AI MASTER</Typography>
            <Typography variant="caption" color="text.secondary" display="block" mt={0.25}>
              MOBILE_REMOTE_ACCESS_M4-A · trạng thái + điều khiển bảo mật
            </Typography>
          </Box>
          <Stack direction="row" spacing={0.7} useFlexGap flexWrap="wrap">
            <Chip label="M4 SECURE CONTROL" color="warning" size="small" variant="outlined" sx={{ fontWeight: 950 }} />
            <Chip label={`MODE ${activeMode}`} size="small" variant="outlined" sx={{ fontWeight: 900 }} />
            <Chip label={ui?.safety.readOnly === true ? "READ DATA CANONICAL ✓" : "READ DATA CHECK"} size="small" color="success" variant="outlined" sx={{ fontWeight: 900 }} />
          </Stack>
        </Stack>
      </Box>

      <Phase7COperatorStatusBar />

      <Phase7CMobileM4ControlCard />

      {(data?.errors ?? []).length > 0 ? (
        <Alert severity="warning" variant="outlined">
          Một số nguồn read-only chưa sẵn sàng: {(data?.errors ?? []).slice(0, 2).join(" ")}
        </Alert>
      ) : null}

      <MobileCard title="BOT ĐANG LÀM GÌ?">
        <Typography
          variant="h5"
          fontWeight={950}
          color={uiState === "WAITING" ? "warning.main" : "success.main"}
        >
          {stateLabel(uiState)}
        </Typography>
        <Typography variant="body2" color="text.secondary" mt={0.6}>
          {activeMode} → {strategy} · {regime} · Confidence {confidence}%
        </Typography>
        <Grid container spacing={1} mt={0.5}>
          <Grid size={{ xs: 6, sm: 3 }}><MobileMetric label="Strategy" valueText={strategy} tone="info" /></Grid>
          <Grid size={{ xs: 6, sm: 3 }}><MobileMetric label="Regime" valueText={regime} /></Grid>
          <Grid size={{ xs: 6, sm: 3 }}><MobileMetric label="Khuyến nghị" valueText={recommendedMode} /></Grid>
          <Grid size={{ xs: 6, sm: 3 }}><MobileMetric label="Bid" valueText={clean(quote.bid, "—")} /></Grid>
        </Grid>
      </MobileCard>

      <Grid container spacing={{ xs: 1.25, sm: 1.5 }}>
        <Grid size={{ xs: 12, md: 6 }}>
          <MobileCard title="LÝ DO HIỆN TẠI">
            <Stack spacing={0.9}>
              {currentReasons.length > 0 ? currentReasons.slice(0, 5).map((reason, index) => (
                <Typography key={`${index}-${reason}`} variant="body2" lineHeight={1.55}>
                  • {reason}
                </Typography>
              )) : (
                <Typography variant="body2" color="text.secondary">Chưa có reason runtime để hiển thị.</Typography>
              )}
            </Stack>
          </MobileCard>
        </Grid>

        <Grid size={{ xs: 12, md: 6 }}>
          <MobileCard title="VỊ THẾ / KẾ HOẠCH">
            {uiState === "MANAGING" ? (
              <Stack>
                <MobileMetric label="Ticket" valueText={clean(position?.ticket, "—")} />
                <MobileMetric label="Side / Volume" valueText={`${clean(position?.side, "—")} / ${clean(position?.volume, "—")}`} />
                <MobileMetric label="Entry" valueText={clean(position?.entry, "—")} tone="info" />
                <MobileMetric label="Stoploss" valueText={clean(position?.stopLoss, "—")} tone="error" />
                <MobileMetric label="TP1 / TP2" valueText={`${clean(position?.tp1, "—")} / ${clean(position?.tp2, "—")}`} tone="success" />
                <MobileMetric label="Floating P/L" valueText={`${clean(position?.floatingPnlUsd, "—")} USD`} tone="info" />
              </Stack>
            ) : uiState === "SETUP_READY" ? (
              <Stack>
                <MobileMetric label="Setup" valueText={clean(setup?.name, "—")} />
                <MobileMetric label="Side / Lot" valueText={`${clean(setup?.side, "—")} / ${clean(setup?.finalLot, "—")}`} />
                <MobileMetric label="Entry" valueText={clean(setup?.entry, "—")} tone="info" />
                <MobileMetric label="Stoploss" valueText={clean(setup?.stopLoss, "—")} tone="error" />
                <MobileMetric label="TP1 / TP2" valueText={`${clean(setup?.tp1, "—")} / ${clean(setup?.tp2, "—")}`} tone="success" />
              </Stack>
            ) : (
              <Alert severity="info" variant="outlined">
                Chưa có setup được duyệt. M1 không dựng Entry / SL / TP giả định.
              </Alert>
            )}
          </MobileCard>
        </Grid>
      </Grid>

      <Box sx={{ px: { xs: 0.3, sm: 0.6 } }}>
        <Typography variant="caption" color="text.secondary" lineHeight={1.5}>
          Dữ liệu trạng thái vẫn đọc từ canonical sources. M4-A chỉ cho đổi MODE và ARM/DISARM qua secure gateway; không đặt lệnh, không sửa vị thế và không điều khiển lifecycle/process.
        </Typography>
      </Box>
    </Stack>
  );
}
