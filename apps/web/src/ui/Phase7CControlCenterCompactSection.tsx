import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  FormControlLabel,
  Grid,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import {
  getPhase7CDecisionMonitor,
  getPhase7CLifecycle,
  getPhase7CLotSettings,
  runPhase7CLifecycleAction,
  setPhase7CBotMode,
  setPhase7CLotSettings,
} from "../api";

function price(value: number | null | undefined) {
  return Number.isFinite(value) ? Number(value).toFixed(2) : "—";
}

function money(value: number | null | undefined, currency = "USD") {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(Number(value));
}

function friendlyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message || "Chưa thực hiện được thao tác.";
}

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography variant="body2" fontWeight={900} noWrap>{value}</Typography>
    </Box>
  );
}

export function Phase7CControlCenterCompactSection({
  detailsOpen,
  onToggleDetails,
}: {
  detailsOpen: boolean;
  onToggleDetails: () => void;
}) {
  const queryClient = useQueryClient();
  const lifecycle = useQuery({
    queryKey: ["phase7c-lifecycle"],
    queryFn: getPhase7CLifecycle,
    refetchInterval: 2_000,
    retry: false,
  });
  const decisionMonitor = useQuery({
    queryKey: ["phase7c-decision-monitor"],
    queryFn: getPhase7CDecisionMonitor,
    refetchInterval: 3_000,
    retry: false,
    enabled: lifecycle.data?.bridge.reachable === true,
  });
  const lotSettings = useQuery({
    queryKey: ["phase7c-lot-settings"],
    queryFn: getPhase7CLotSettings,
    refetchInterval: 5_000,
    retry: false,
  });

  const lifecycleAction = useMutation({
    mutationFn: runPhase7CLifecycleAction,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["phase7c-lifecycle"] }),
        queryClient.invalidateQueries({ queryKey: ["phase7c-decision-monitor"] }),
        queryClient.invalidateQueries({ queryKey: ["phase7c-lot-settings"] }),
      ]);
    },
  });
  const botModeAction = useMutation({
    mutationFn: () => setPhase7CBotMode("PAUSE"),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["phase7c-lifecycle"] }),
        queryClient.invalidateQueries({ queryKey: ["phase7c-decision-monitor"] }),
        queryClient.invalidateQueries({ queryKey: ["phase7c-auto-activation-status"] }),
      ]);
    },
  });

  const configuredTrendLot = lotSettings.data?.state.trendFixedLot ?? 0.03;
  const configuredSidewayRisk = lotSettings.data?.state.sidewayRiskPercent ?? 0.25;
  const configuredSidewayMaxLot = lotSettings.data?.state.sidewayMaxLot ?? 0.03;
  const configuredTrendFixedTpEnabled = lotSettings.data?.state.trendFixedTpEnabled ?? false;
  const configuredTrendFixedTpDistance = lotSettings.data?.state.trendFixedTpDistance ?? 0;
  const configuredSidewayFixedTpEnabled = lotSettings.data?.state.sidewayFixedTpEnabled ?? false;
  const configuredSidewayFixedTpDistance = lotSettings.data?.state.sidewayFixedTpDistance ?? 0;

  const [fixedTpDraft, setFixedTpDraft] = useState<{
    trendFixedTpEnabled: boolean;
    trendFixedTpDistance: number;
    sidewayFixedTpEnabled: boolean;
    sidewayFixedTpDistance: number;
  } | null>(null);
  const trendFixedTpEnabled = fixedTpDraft?.trendFixedTpEnabled ?? configuredTrendFixedTpEnabled;
  const trendFixedTpDistance = fixedTpDraft?.trendFixedTpDistance ?? configuredTrendFixedTpDistance;
  const sidewayFixedTpEnabled = fixedTpDraft?.sidewayFixedTpEnabled ?? configuredSidewayFixedTpEnabled;
  const sidewayFixedTpDistance = fixedTpDraft?.sidewayFixedTpDistance ?? configuredSidewayFixedTpDistance;
  const updateFixedTpDraft = (patch: Partial<NonNullable<typeof fixedTpDraft>>) => {
    setFixedTpDraft((current) => ({
      trendFixedTpEnabled: current?.trendFixedTpEnabled ?? configuredTrendFixedTpEnabled,
      trendFixedTpDistance: current?.trendFixedTpDistance ?? configuredTrendFixedTpDistance,
      sidewayFixedTpEnabled: current?.sidewayFixedTpEnabled ?? configuredSidewayFixedTpEnabled,
      sidewayFixedTpDistance: current?.sidewayFixedTpDistance ?? configuredSidewayFixedTpDistance,
      ...patch,
    }));
  };

  const saveLotSettings = useMutation({
    mutationFn: setPhase7CLotSettings,
    onSuccess: async () => {
      setFixedTpDraft(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["phase7c-lot-settings"] }),
        queryClient.invalidateQueries({ queryKey: ["phase7c-decision-monitor"] }),
        queryClient.invalidateQueries({ queryKey: ["phase7c-lifecycle"] }),
      ]);
    },
  });

  const lifecycleData = lifecycle.data;
  const decision = decisionMonitor.data;
  const preTrade = decision?.preTrade;
  const position = decision?.position;
  const managing = position?.state === "MANAGING";
  const unmanaged = position?.state === "UNMANAGED";
  const hasOpenPosition = managing || unmanaged;
  const mode = lifecycleData?.mode.mode ?? decision?.mode.active ?? "—";
  const strategy = decision?.engine.recommendedMode ?? "—";
  const regime = decision?.engine.regime ?? "—";
  const displayedEntry = hasOpenPosition ? position?.entry : preTrade?.entry;
  const displayedStop = hasOpenPosition ? position?.stopLoss : preTrade?.stopLoss;
  const displayedTp = managing ? position?.tp1 : unmanaged ? null : preTrade?.tp1;
  const displayedLot = hasOpenPosition ? position?.volume : preTrade?.finalLot;
  const displayedPnl = hasOpenPosition ? position?.floatingPnlUsd : null;
  const currency = decision?.account.currency ?? "USD";
  const reason = hasOpenPosition
    ? position?.holdReason ?? position?.entryReason ?? "Executor đang quản lý vị thế."
    : mode === "PAUSE"
      ? "Bot đang PAUSE; không mở kế hoạch giao dịch mới."
      : preTrade?.decisionReason ?? "Chưa có setup hợp lệ; tiếp tục chờ tín hiệu.";

  const bridgeReady = lifecycleData?.bridge.reachable === true;
  const brokerModeSupported = lifecycleData?.bridge.accountMode === "demo" || lifecycleData?.bridge.accountMode === "real";
  const openPositions = lifecycleData?.bridge.openXauusdPositions ?? 0;
  const canPause = lifecycleData?.controlEnabled === true && mode !== "PAUSE";
  const canChangeFixedTp =
    mode === "PAUSE" &&
    bridgeReady &&
    brokerModeSupported &&
    openPositions === 0;

  return (
    <Stack spacing={1.5}>
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, lg: 6 }}>
          <Card variant="outlined" sx={{ borderRadius: 3, height: "100%" }}>
            <CardContent sx={{ p: { xs: 1.7, md: 2 } }}>
              <Stack spacing={1.5}>
                <Stack direction="row" justifyContent="space-between" gap={1} alignItems="center">
                  <Box>
                    <Typography variant="h6" fontWeight={950}>Điều khiển Bot</Typography>
                    <Typography variant="caption" color="text.secondary">
                      Dùng đúng lifecycle canonical; Bật/Khôi phục luôn kết thúc ở PAUSE và không tự bật AUTO.
                    </Typography>
                  </Box>
                  <Chip
                    label={lifecycleData?.ready ? "SẴN SÀNG" : lifecycleData?.running ? "ĐANG KHỞI ĐỘNG" : "ĐÃ DỪNG"}
                    size="small"
                    color={lifecycleData?.ready ? "success" : lifecycleData?.running ? "warning" : "default"}
                  />
                </Stack>

                <Stack direction="row" spacing={0.7} useFlexGap flexWrap="wrap">
                  <Chip size="small" label={`MODE ${mode}`} variant="outlined" />
                  <Chip size="small" label={bridgeReady ? "MT5 ĐÃ KẾT NỐI" : "MT5 OFFLINE"} color={bridgeReady ? "success" : "warning"} variant="outlined" />
                  <Chip size="small" label={lifecycleData?.telegramReady ? "TELEGRAM SẴN SÀNG" : "TELEGRAM OFFLINE"} color={lifecycleData?.telegramReady ? "success" : "default"} variant="outlined" />
                  <Chip size="small" label={`POSITIONS ${openPositions}`} variant="outlined" />
                </Stack>

                <Grid container spacing={1}>
                  <Grid size={{ xs: 12, sm: 4 }}>
                    <Button
                      fullWidth
                      variant="contained"
                      color="success"
                      disabled={
                        lifecycleAction.isPending || lifecycleData?.actionInProgress || lifecycleData?.ready ||
                        !lifecycleData?.controlEnabled || !bridgeReady || !brokerModeSupported ||
                        lifecycleData?.bridge.tradingEnabled !== true ||
                        lifecycleData?.bridge.terminalTradeAllowed !== true ||
                        lifecycleData?.bridge.expertTradeAllowed !== true ||
                        openPositions > 0 || !lifecycleData?.telegramConfigured
                      }
                      onClick={() => lifecycleAction.mutate("start")}
                      sx={{ fontWeight: 950 }}
                    >
                      {lifecycleAction.isPending && lifecycleAction.variables === "start"
                        ? "ĐANG BẬT..."
                        : lifecycleData?.running ? "KHÔI PHỤC BOT" : "BẬT BOT"}
                    </Button>
                  </Grid>
                  <Grid size={{ xs: 12, sm: 4 }}>
                    <Button
                      fullWidth
                      variant="outlined"
                      color="warning"
                      disabled={!canPause || botModeAction.isPending}
                      onClick={() => botModeAction.mutate()}
                      sx={{ fontWeight: 950 }}
                    >
                      {botModeAction.isPending ? "ĐANG PAUSE..." : "TẠM DỪNG"}
                    </Button>
                  </Grid>
                  <Grid size={{ xs: 12, sm: 4 }}>
                    <Button
                      fullWidth
                      variant="outlined"
                      color="error"
                      disabled={
                        lifecycleAction.isPending || lifecycleData?.actionInProgress || !lifecycleData?.running ||
                        !lifecycleData?.controlEnabled || openPositions > 0
                      }
                      onClick={() => lifecycleAction.mutate("stop")}
                      sx={{ fontWeight: 950 }}
                    >
                      {lifecycleAction.isPending && lifecycleAction.variables === "stop" ? "ĐANG TẮT..." : "TẮT BOT"}
                    </Button>
                  </Grid>
                </Grid>

                {openPositions > 0 ? (
                  <Alert severity="info" sx={{ py: 0.4 }}>
                    Đang có vị thế XAUUSD: TẮT BOT bị khóa; TẠM DỪNG mode vẫn khả dụng để executor tiếp tục quản lý lệnh.
                  </Alert>
                ) : null}
                {lifecycleAction.error ? <Alert severity="error" sx={{ py: 0.4 }}>{friendlyError(lifecycleAction.error)}</Alert> : null}
                {botModeAction.error ? <Alert severity="error" sx={{ py: 0.4 }}>{friendlyError(botModeAction.error)}</Alert> : null}
              </Stack>
            </CardContent>
          </Card>
        </Grid>

        <Grid size={{ xs: 12, lg: 6 }}>
          <Card variant="outlined" sx={{ borderRadius: 3, height: "100%" }}>
            <CardContent sx={{ p: { xs: 1.7, md: 2 } }}>
              <Stack spacing={1.3}>
                <Stack direction="row" justifyContent="space-between" gap={1} alignItems="center">
                  <Box>
                    <Typography variant="h6" fontWeight={950}>Lot / Fixed TP</Typography>
                    <Typography variant="caption" color="text.secondary">
                      Chỉnh Fixed TP ngay tại Trung tâm điều khiển; Lot/Risk được gửi lại nguyên giá trị canonical hiện hành.
                    </Typography>
                  </Box>
                  <Chip label="CONFIG" size="small" variant="outlined" />
                </Stack>

                <Stack direction="row" spacing={0.7} useFlexGap flexWrap="wrap">
                  <Chip size="small" label={`TREND LOT ${configuredTrendLot.toFixed(2)}`} variant="outlined" />
                  <Chip size="small" label={`SIDEWAY ${configuredSidewayRisk.toFixed(2)}% / ${configuredSidewayMaxLot.toFixed(2)}`} variant="outlined" />
                </Stack>

                <Grid container spacing={1.2}>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <Box sx={{ p: 1.2, border: "1px solid", borderColor: "divider", borderRadius: 2 }}>
                      <FormControlLabel
                        control={<Switch checked={trendFixedTpEnabled} onChange={(event) => updateFixedTpDraft({ trendFixedTpEnabled: event.target.checked })} />}
                        label="Trend Fixed TP"
                      />
                      <TextField
                        fullWidth
                        size="small"
                        type="number"
                        label="Trend Fixed TP distance"
                        value={trendFixedTpDistance}
                        disabled={!trendFixedTpEnabled}
                        onChange={(event) => updateFixedTpDraft({ trendFixedTpDistance: Number(event.target.value) })}
                        slotProps={{ htmlInput: { min: 0, step: 0.01 } }}
                      />
                    </Box>
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <Box sx={{ p: 1.2, border: "1px solid", borderColor: "divider", borderRadius: 2 }}>
                      <FormControlLabel
                        control={<Switch checked={sidewayFixedTpEnabled} onChange={(event) => updateFixedTpDraft({ sidewayFixedTpEnabled: event.target.checked })} />}
                        label="Sideway Fixed TP"
                      />
                      <TextField
                        fullWidth
                        size="small"
                        type="number"
                        label="Sideway Fixed TP distance"
                        value={sidewayFixedTpDistance}
                        disabled={!sidewayFixedTpEnabled}
                        onChange={(event) => updateFixedTpDraft({ sidewayFixedTpDistance: Number(event.target.value) })}
                        slotProps={{ htmlInput: { min: 0, step: 0.01 } }}
                      />
                    </Box>
                  </Grid>
                </Grid>

                <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ sm: "center" }}>
                  <Button
                    variant="contained"
                    disabled={!canChangeFixedTp || saveLotSettings.isPending || !lotSettings.data}
                    onClick={() => saveLotSettings.mutate({
                      trendFixedLot: configuredTrendLot,
                      sidewayRiskPercent: configuredSidewayRisk,
                      sidewayMaxLot: configuredSidewayMaxLot,
                      trendFixedTpEnabled,
                      trendFixedTpDistance,
                      sidewayFixedTpEnabled,
                      sidewayFixedTpDistance,
                    })}
                    sx={{ fontWeight: 950 }}
                  >
                    {saveLotSettings.isPending ? "ĐANG LƯU..." : "Lưu cấu hình Fixed TP"}
                  </Button>
                  <Typography variant="caption" color="text.secondary">
                    Chỉ lưu khi PAUSE, MT5 hợp lệ và XAUUSD positions = 0.
                  </Typography>
                </Stack>

                {saveLotSettings.error ? <Alert severity="error" sx={{ py: 0.4 }}>{friendlyError(saveLotSettings.error)}</Alert> : null}
                {lotSettings.data?.restartRequired ? (
                  <Alert severity="warning" sx={{ py: 0.4 }}>
                    Cấu hình đã lưu nhưng chưa active. Giữ PAUSE rồi bấm KHÔI PHỤC BOT để nạp cấu hình mới.
                  </Alert>
                ) : null}
              </Stack>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      <Card variant="outlined" sx={{ borderRadius: 3 }}>
        <CardContent sx={{ p: { xs: 1.7, md: 2 } }}>
          <Stack spacing={1.6}>
            <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" gap={1.2} alignItems={{ md: "center" }}>
              <Box>
                <Stack direction="row" spacing={0.8} useFlexGap flexWrap="wrap" alignItems="center">
                  <Typography variant="h6" fontWeight={950}>Quyết định hiện tại</Typography>
                  <Chip label={`MODE ${mode}`} size="small" variant="outlined" />
                  <Chip label={`REGIME ${regime}`} size="small" variant="outlined" />
                  <Chip label={`BOT ${strategy}`} size="small" color={strategy === "TREND" || strategy === "SIDEWAY" ? "primary" : "default"} variant="outlined" />
                </Stack>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.45 }}>
                  {reason}
                </Typography>
              </Box>
              <Button
                size="small"
                variant="outlined"
                aria-expanded={detailsOpen}
                onClick={onToggleDetails}
                sx={{ fontWeight: 900, whiteSpace: "nowrap" }}
              >
                {detailsOpen ? "Ẩn điều khiển chi tiết" : "Mở điều khiển chi tiết"}
              </Button>
            </Stack>

            <Grid container spacing={1.4}>
              <Grid size={{ xs: 6, sm: 4, lg: 2 }}><SummaryMetric label="Entry" value={price(displayedEntry)} /></Grid>
              <Grid size={{ xs: 6, sm: 4, lg: 2 }}><SummaryMetric label="Stop Loss" value={price(displayedStop)} /></Grid>
              <Grid size={{ xs: 6, sm: 4, lg: 2 }}><SummaryMetric label="TP" value={price(displayedTp)} /></Grid>
              <Grid size={{ xs: 6, sm: 4, lg: 2 }}><SummaryMetric label="Lot" value={displayedLot === null || displayedLot === undefined ? "—" : Number(displayedLot).toFixed(2)} /></Grid>
              <Grid size={{ xs: 6, sm: 4, lg: 2 }}><SummaryMetric label="P/L" value={money(displayedPnl, currency)} /></Grid>
              <Grid size={{ xs: 6, sm: 4, lg: 2 }}><SummaryMetric label="Positions" value={String(openPositions)} /></Grid>
            </Grid>
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}
