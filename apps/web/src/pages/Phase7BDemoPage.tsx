import { type ReactNode, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Grid,
  Stack,
  Typography,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { LoadingState, ErrorState } from "../ui/PageState";
import { Phase7CChartPatternAdvisorCard } from "../ui/Phase7CChartPatternAdvisorCard";
import {
  clean,
  compactReason,
  fetchPhase7CPerformance,
  fetchPhase7CWebStatus,
  getTradeUiState,
  money,
  pickText,
  raw,
  stageTone,
  value,
  type Phase7CPerformanceTrade,
  type Phase7CUiGate,
} from "../phase7c-panel-status";

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function PanelCard({ title, children, accent = "cyan" }: { title: string; children: ReactNode; accent?: "cyan" | "green" | "red" | "orange" | "purple" }) {
  const colorMap = {
    cyan: "rgba(0,213,255,.42)",
    green: "rgba(74,222,128,.42)",
    red: "rgba(248,113,113,.42)",
    orange: "rgba(251,191,36,.42)",
    purple: "rgba(168,85,247,.42)",
  } as const;
  return (
    <Card variant="outlined" sx={{ height: "100%", borderRadius: 3, bgcolor: "rgba(3,10,18,.72)", borderColor: colorMap[accent] }}>
      <CardContent sx={{ p: 2.2 }}>
        <Typography variant="subtitle2" fontWeight={950} sx={{ letterSpacing: ".03em" }}>{title}</Typography>
        <Box mt={1.4}>{children}</Box>
      </CardContent>
    </Card>
  );
}

function InfoRow({ label, valueText, tone = "default" }: { label: string; valueText: string; tone?: "default" | "success" | "error" | "warning" | "info" }) {
  const color = tone === "success" ? "success.main" : tone === "error" ? "error.main" : tone === "warning" ? "warning.main" : tone === "info" ? "info.main" : "text.primary";
  return (
    <Stack direction="row" justifyContent="space-between" gap={2} py={0.7} sx={{ borderBottom: "1px solid rgba(148,163,184,.09)" }}>
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Typography variant="body2" fontWeight={900} color={color} textAlign="right">{valueText}</Typography>
    </Stack>
  );
}

function HeaderChip({ label, valueText, color = "default" }: { label: string; valueText: string; color?: "success" | "warning" | "error" | "info" | "secondary" | "default" }) {
  return (
    <Stack spacing={0.6} alignItems="center" minWidth={112}>
      <Typography variant="caption" color="text.secondary" fontWeight={900}>{label}</Typography>
      <Chip label={valueText} color={color} sx={{ fontWeight: 950, minWidth: 96 }} />
    </Stack>
  );
}

function ReasonBox({ title, items, accent = "cyan", emptyText = "Chưa có dữ liệu từ engine." }: { title: string; items: string[]; accent?: "cyan" | "purple" | "orange" | "green"; emptyText?: string }) {
  return (
    <PanelCard title={title} accent={accent}>
      <Stack spacing={0.9}>
        {items.length === 0 ? (
          <Typography variant="body2" color="text.secondary">{emptyText}</Typography>
        ) : items.map((item, index) => (
          <Typography key={`${title}-${index}`} variant="body2" lineHeight={1.5}>• {item}</Typography>
        ))}
      </Stack>
    </PanelCard>
  );
}

function StatusDot({ label, ok }: { label: string; ok: boolean }) {
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="center" py={0.55}>
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Stack direction="row" spacing={0.8} alignItems="center">
        <Box sx={{ width: 9, height: 9, borderRadius: "50%", bgcolor: ok ? "success.main" : "warning.main", boxShadow: ok ? "0 0 10px rgba(34,197,94,.65)" : "none" }} />
        <Typography variant="caption" fontWeight={900}>{ok ? "READY" : "CHECK"}</Typography>
      </Stack>
    </Stack>
  );
}

function gateLabel(gate: Phase7CUiGate | undefined) {
  if (gate === "ALLOWED") return "ĐƯỢC PHÉP";
  if (gate === "BLOCKED_BY_MODE") return "CHẶN DO MODE";
  if (gate === "BLOCKED_BY_REGIME") return "CHƯA CHO PHÉP";
  return "ĐANG CHỜ";
}

function gateTone(gate: Phase7CUiGate | undefined): "success" | "warning" | "default" {
  if (gate === "ALLOWED") return "success";
  if (gate === "BLOCKED_BY_MODE" || gate === "BLOCKED_BY_REGIME") return "warning";
  return "default";
}

function formatTradeTime(timestamp: number) {
  if (!Number.isFinite(timestamp)) return "—";
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function price(input: number) {
  return Number.isFinite(input) ? input.toFixed(2) : "—";
}

function normalizeAccountMode(...candidates: unknown[]): "DEMO" | "LIVE" | "CHECK" {
  for (const candidate of candidates) {
    const text = String(candidate ?? "").trim().toUpperCase();
    if (text === "LIVE" || text === "REAL") return "LIVE";
    if (text === "DEMO") return "DEMO";
  }
  return "CHECK";
}

function RecentTradeJournal({ trades, currency, loading, error }: { trades: Phase7CPerformanceTrade[]; currency: string; loading: boolean; error?: string }) {
  const recent = trades.slice(0, 6);
  return (
    <PanelCard title="NHẬT KÝ GIAO DỊCH GẦN NHẤT" accent="cyan">
      {loading && recent.length === 0 ? (
        <Typography variant="body2" color="text.secondary">Đang tải lịch sử giao dịch thật từ MT5...</Typography>
      ) : error && recent.length === 0 ? (
        <Typography variant="body2" color="warning.main">Chưa đọc được lịch sử MT5: {error}</Typography>
      ) : recent.length === 0 ? (
        <Typography variant="body2" color="text.secondary">Chưa có lệnh XAUUSD đã đóng trong cửa sổ 90 ngày. Dashboard không tạo dữ liệu minh họa.</Typography>
      ) : (
        <Box sx={{ overflowX: "auto" }}>
          <Box sx={{ minWidth: 720 }}>
            <Box sx={{ display: "grid", gridTemplateColumns: "110px 90px 70px 70px 1fr 100px", gap: 1, px: 1, pb: 1, borderBottom: "1px solid rgba(148,163,184,.18)" }}>
              {["Đóng lệnh", "Strategy", "Side", "Lot", "Entry → Exit", "P/L"].map((label) => (
                <Typography key={label} variant="caption" color="text.secondary" fontWeight={900}>{label}</Typography>
              ))}
            </Box>
            {recent.map((trade) => (
              <Box key={trade.id} sx={{ display: "grid", gridTemplateColumns: "110px 90px 70px 70px 1fr 100px", gap: 1, alignItems: "center", px: 1, py: 1.05, borderBottom: "1px solid rgba(148,163,184,.08)" }}>
                <Typography variant="caption">{formatTradeTime(trade.closedAt)}</Typography>
                <Chip size="small" label={trade.strategy} variant="outlined" color={trade.strategy === "SIDEWAY" ? "info" : trade.strategy === "TREND" ? "secondary" : "default"} sx={{ width: "fit-content", fontWeight: 850 }} />
                <Typography variant="body2" fontWeight={900} color={trade.side === "BUY" ? "success.main" : "error.main"}>{trade.side}</Typography>
                <Typography variant="body2">{trade.volume.toFixed(2)}</Typography>
                <Typography variant="body2">{price(trade.entry)} → {price(trade.exit)}</Typography>
                <Typography variant="body2" fontWeight={950} color={trade.netPnl >= 0 ? "success.main" : "error.main"}>{trade.netPnl >= 0 ? "+" : ""}{trade.netPnl.toFixed(2)} {currency}</Typography>
              </Box>
            ))}
          </Box>
        </Box>
      )}
    </PanelCard>
  );
}

export function Phase7BDemoPage() {
  const [easyMode, setEasyMode] = useState(true);
  const query = useQuery({
    queryKey: ["phase7c-web-final-dashboard-v6-account-aware"],
    queryFn: fetchPhase7CWebStatus,
    refetchInterval: 3_000,
    retry: false,
    placeholderData: (previous) => previous,
  });
  const performanceQuery = useQuery({
    queryKey: ["phase7c-web-mt5-performance-selected-account-90d"],
    queryFn: fetchPhase7CPerformance,
    refetchInterval: 30_000,
    retry: false,
    placeholderData: (previous) => previous,
  });

  if (query.isLoading) return <LoadingState />;
  if (query.isError && !query.data) return <ErrorState message={query.error instanceof Error ? query.error.message : "Không đọc được Dashboard."} />;

  const data = query.data;
  const panel = data?.panel;
  const ui = data?.ui;
  const lifecycle = asRecord(data?.lifecycle);
  const accountRisk = asRecord(data?.accountRisk);
  const account = asRecord(accountRisk.account);
  const config = asRecord(accountRisk.configuration);
  const bridge = asRecord(lifecycle.bridge);
  const processes = asRecord(lifecycle.processes);
  const lotRuntime = asRecord(lifecycle.lotSettings);
  const accountMode = normalizeAccountMode(ui?.safety.accountMode, raw(panel, "configuredAccountMode"), raw(panel, "accountMode"), account.accountMode, bridge.accountMode, performanceQuery.data?.account?.accountMode);
  const currency = clean(account.accountCurrency, performanceQuery.data?.currency ?? "USD");
  const activeMode = clean(ui?.mode, value(panel, "activeMode", "—"));
  const effectiveStrategy = clean(ui?.effectiveStrategy, value(panel, "effectiveStrategy", "—"));
  const mode = activeMode !== effectiveStrategy && effectiveStrategy !== "—" ? `${activeMode} → ${effectiveStrategy}` : activeMode;
  const stage = clean(ui?.stage, value(panel, "stage", "—"));
  const regime = clean(ui?.regime, value(panel, "regime", "—"));
  const confidence = clean(ui?.confidence, value(panel, "confidence", "—"));
  const uiState = getTradeUiState(panel, ui);
  const hasPosition = uiState === "MANAGING";
  const setupReady = uiState === "SETUP_READY";

  const autoReasons = ui?.reasons.auto?.length
    ? ui.reasons.auto
    : compactReason(raw(panel, "decisionReason"), "AUTO/Regime engine chưa trả lý do chọn strategy.");
  const trendWaitReasons = ui?.reasons.trendWait?.length
    ? ui.reasons.trendWait
    : ["Chưa có Trend decision mới từ canonical journal."];
  const sidewayWaitReasons = ui?.reasons.sidewayWait?.length
    ? ui.reasons.sidewayWait
    : ["Chưa có Sideway decision mới từ canonical journal."];
  const entryReasons = ui?.reasons.entry?.length
    ? ui.reasons.entry
    : compactReason(raw(panel, "entryReason"), "Engine chưa trả lý do vào lệnh.");
  const holdReasons = ui?.reasons.hold?.length
    ? ui.reasons.hold
    : compactReason(raw(panel, "holdReason"), "Engine chưa trả lý do giữ lệnh.");
  const stopMoveReasons = ui?.reasons.stopMove ?? [];
  const partialReasons = ui?.reasons.partial ?? [];
  const exitReasons = ui?.reasons.exit ?? [];
  const setup = ui?.setup;
  const position = ui?.position;
  const profit = position?.floatingPnlUsd ?? Number(raw(panel, "floatingPnlUsd"));
  const profitText = Number.isFinite(profit) ? `${Number(profit).toFixed(2)} USD` : "—";
  const performanceError = performanceQuery.error instanceof Error ? performanceQuery.error.message : undefined;

  return (
    <Stack spacing={2.4}>
      <Box sx={{ p: 2, borderRadius: 4, bgcolor: "rgba(3,10,18,.82)", border: "1px solid rgba(0,213,255,.18)" }}>
        <Stack direction={{ xs: "column", xl: "row" }} justifyContent="space-between" gap={2} alignItems={{ xl: "center" }}>
          <Box>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography variant="h5" fontWeight={950}>XAUUSD AI MASTER</Typography>
              <Chip label="PHASE7C" color="secondary" size="small" sx={{ fontWeight: 950 }} />
              {ui && <Chip label="SEMANTIC UI v2" size="small" variant="outlined" color="info" sx={{ fontWeight: 900 }} />}
              {performanceQuery.data && <Chip label="MT5 JOURNAL" size="small" variant="outlined" color="success" sx={{ fontWeight: 900 }} />}
              <Chip label={accountMode} size="small" color={accountMode === "LIVE" ? "warning" : accountMode === "DEMO" ? "success" : "default"} sx={{ fontWeight: 950 }} />
            </Stack>
            <Typography variant="body2" color="text.secondary" mt={0.5}>MT5 DASHBOARD · LIVE DATA · {accountMode} · PANEL READ ONLY</Typography>
          </Box>
          <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap alignItems="center">
            <HeaderChip label="CHẾ ĐỘ BOT" valueText={mode} color={effectiveStrategy === "PAUSE" ? "warning" : "success"} />
            <HeaderChip label="TRẠNG THÁI" valueText={stage} color={stageTone(stage)} />
            <HeaderChip label="REGIME" valueText={regime} color={regime === "REVERSAL" ? "warning" : "info"} />
            <HeaderChip label="CONF" valueText={`${confidence}%`} />
            <Button
              size="small"
              variant={easyMode ? "contained" : "outlined"}
              color="primary"
              onClick={() => setEasyMode((v) => !v)}
              sx={{ fontWeight: 900 }}
            >
              {easyMode ? "Đang bật: Giao diện Dễ Nhìn" : "Bật Giao diện Dễ Nhìn"}
            </Button>
            <Button size="small" variant="outlined" component={RouterLink} to="/backtest" sx={{ fontWeight: 900 }}>
              Mở Backtest & Đánh giá Bot →
            </Button>
          </Stack>
        </Stack>
      </Box>

      {easyMode && <Phase7CChartPatternAdvisorCard />}

      {data?.usedDirectFallback && <Alert severity="info">Web proxy 5717 chưa ổn định nên một số nguồn đang đọc trực tiếp Control API 3711.</Alert>}
      {(data?.errors ?? []).length > 0 && <Alert severity="warning">Nguồn chưa sẵn sàng: {(data?.errors ?? []).slice(0, 3).join(" ")}</Alert>}

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, lg: 3 }}>
          <Stack spacing={2}>
            <PanelCard title="TÀI KHOẢN" accent="cyan">
              <InfoRow label="Server" valueText={pickText(account.server, bridge.server, performanceQuery.data?.account?.server)} />
              <InfoRow label="Account" valueText={pickText(account.accountLogin, bridge.accountLogin, performanceQuery.data?.account?.login)} />
              <InfoRow label="Mode" valueText={accountMode} tone={accountMode === "LIVE" ? "warning" : "success"} />
              <InfoRow label="Balance" valueText={money(account.accountBalance, currency)} />
              <InfoRow label="Equity" valueText={money(account.accountEquity, currency)} />
              <InfoRow label="Free Margin" valueText={money(account.accountFreeMargin, currency)} />
              <InfoRow label="Profit" valueText={money(account.accountProfit, currency)} tone={Number(account.accountProfit) >= 0 ? "success" : "error"} />
            </PanelCard>

            <PanelCard title="CẤU HÌNH LOT" accent="green">
              <InfoRow label="Trend Fixed Lot" valueText={pickText(config.configuredTrendFixedLot, "0.12")} />
              <InfoRow label="Sideway Risk %" valueText={`${pickText(config.configuredSidewayRiskPercent, "1")}%`} />
              <InfoRow label="Sideway Max Lot" valueText={pickText(config.configuredSidewayMaxLot, accountMode === "LIVE" ? "0.12" : "0.30")} />
              <InfoRow label="Auto Lot Mode" valueText="AUTO_LOT_SHADOW" />
              <InfoRow label="Áp dụng" valueText="NEW_POSITIONS_ONLY" />
            </PanelCard>

            <PanelCard title="TRẠNG THÁI HỆ THỐNG" accent="green">
              <StatusDot label="MT5 Bridge" ok={Object.keys(bridge).length > 0} />
              <StatusDot label="Semantic UI" ok={Boolean(ui)} />
              <StatusDot label="Decision Engine" ok={Boolean(panel)} />
              <StatusDot label="Risk Manager" ok={Boolean(accountRisk.configuration)} />
              <StatusDot label="Trend Executor" ok={Boolean(asRecord(processes.trend).alive)} />
              <StatusDot label="Sideway Executor" ok={Boolean(asRecord(processes.sideway).alive)} />
              <StatusDot label="Telegram" ok={Boolean(lifecycle.telegramReady)} />
              <StatusDot label="Lot Binding" ok={Boolean(lotRuntime.activeAlive)} />
              <StatusDot label="MT5 Journal" ok={Boolean(performanceQuery.data)} />
            </PanelCard>
          </Stack>
        </Grid>

        <Grid size={{ xs: 12, lg: 6 }}>
          <Stack spacing={2}>
            <RecentTradeJournal
              trades={performanceQuery.data?.trades ?? []}
              currency={currency}
              loading={performanceQuery.isLoading}
              error={performanceError}
            />
          </Stack>
        </Grid>

        <Grid size={{ xs: 12, lg: 3 }}>
          <Stack spacing={2}>
            {uiState === "WAITING" && (
              <>
                <PanelCard title="TRẠNG THÁI GIAO DỊCH" accent="orange">
                  <Typography variant="body2">Không có vị thế XAUUSD đang mở.</Typography>
                  <Typography variant="body2" color="text.secondary" mt={0.8}>Bot đang chờ setup hợp lệ. Entry / SL / TP được ẩn cho tới khi strategy tương ứng duyệt setup.</Typography>
                </PanelCard>
                <ReasonBox title="AUTO / REGIME — LÝ DO CHỌN STRATEGY" items={autoReasons} accent="orange" />
                <ReasonBox title="TREND — LÝ DO CHƯA VÀO LỆNH" items={trendWaitReasons} accent="purple" />
                <ReasonBox title="SIDEWAY — LÝ DO CHƯA VÀO LỆNH" items={sidewayWaitReasons} accent="cyan" />
                <PanelCard title="BOT GATE / FILTER" accent={regime === "REVERSAL" ? "orange" : "cyan"}>
                  <InfoRow label="Trend gate" valueText={gateLabel(ui?.gates.trend)} tone={gateTone(ui?.gates.trend)} />
                  <InfoRow label="Sideway gate" valueText={gateLabel(ui?.gates.sideway)} tone={gateTone(ui?.gates.sideway)} />
                  <InfoRow label="Reversal filter" valueText={ui?.gates.reversalFilter === "BLOCKING" ? "ĐANG CHẶN" : "KHÔNG CHẶN"} tone={ui?.gates.reversalFilter === "BLOCKING" ? "warning" : "success"} />
                  <InfoRow label="Recommended" valueText={clean(ui?.recommendedMode, value(panel, "recommendedMode", "—"))} />
                </PanelCard>
              </>
            )}

            {setupReady && (
              <>
                <PanelCard title="SETUP ĐANG CHỜ" accent="green">
                  <InfoRow label="Strategy" valueText={clean(setup?.strategy, value(panel, "effectiveStrategy", "—"))} />
                  <InfoRow label="Setup" valueText={clean(setup?.name, "—")} />
                  <InfoRow label="Side" valueText={clean(setup?.side, value(panel, "side", "—"))} />
                  <InfoRow label="Entry" valueText={clean(setup?.entry, value(panel, "entry", "—"))} tone="info" />
                  <InfoRow label="Stop Loss" valueText={clean(setup?.stopLoss, value(panel, "stopLoss", "—"))} tone="error" />
                  <InfoRow label="TP1" valueText={clean(setup?.tp1, value(panel, "tp1", "—"))} tone="success" />
                  <InfoRow label="TP2" valueText={clean(setup?.tp2, value(panel, "tp2", "—"))} tone="success" />
                  <InfoRow label="Lot dự kiến" valueText={clean(setup?.finalLot, value(panel, "finalLot", "—"))} />
                  <InfoRow label="Risk %" valueText={clean(setup?.estimatedRiskPercent, value(panel, "estimatedRiskPercent", "—"))} />
                </PanelCard>
                <ReasonBox title="LÝ DO SETUP ĐƯỢC DUYỆT" items={entryReasons} accent="green" />
                <ReasonBox title="AUTO / REGIME — LÝ DO CHỌN STRATEGY" items={autoReasons} accent="orange" />
              </>
            )}

            {hasPosition && (
              <>
                <PanelCard title="CHI TIẾT LỆNH ĐANG MỞ" accent="green">
                  <InfoRow label="Ticket" valueText={clean(position?.ticket, "—")} />
                  <InfoRow label="Strategy" valueText={clean(position?.strategy, "—")} />
                  <InfoRow label="Side" valueText={clean(position?.side, value(panel, "positionSide", value(panel, "side", "—")))} tone="success" />
                  <InfoRow label="Entry" valueText={clean(position?.entry, value(panel, "positionEntry", value(panel, "entry", "—")))} />
                  <InfoRow label="Stop Loss" valueText={clean(position?.stopLoss, value(panel, "positionStopLoss", value(panel, "stopLoss", "—")))} tone="error" />
                  <InfoRow label="TP1" valueText={clean(position?.tp1, value(panel, "positionTp1", value(panel, "tp1", "—")))} tone="success" />
                  <InfoRow label="TP2" valueText={clean(position?.tp2, value(panel, "positionTp2", value(panel, "tp2", "—")))} tone="success" />
                  <InfoRow label="Lot" valueText={clean(position?.volume, value(panel, "positionVolume", value(panel, "finalLot", "—")))} />
                </PanelCard>
                <ReasonBox title="LÝ DO VÀO LỆNH" items={entryReasons} accent="cyan" />
                <ReasonBox title="LÝ DO GIỮ LỆNH" items={holdReasons} accent="purple" />
                <ReasonBox title="LÝ DO DỜI STOP LOSS" items={stopMoveReasons} accent="green" emptyText="Chưa phát sinh lần dời SL nào trong lệnh hiện tại." />
                <ReasonBox title="LÝ DO CHỐT 1/3" items={partialReasons} accent="green" emptyText="Chưa đạt mốc +10 hoặc chưa phát sinh partial." />
                <ReasonBox title="LÝ DO ĐÓNG TOÀN BỘ" items={exitReasons} accent="orange" emptyText="Chưa phát sinh điều kiện đóng toàn bộ vị thế." />
                <PanelCard title="PROFIT" accent={Number(profit) >= 0 ? "green" : "red"}>
                  <Typography variant="h4" fontWeight={950} color={Number(profit) >= 0 ? "success.main" : "error.main"}>{profitText}</Typography>
                  {position?.floatingPnlPercent !== null && position?.floatingPnlPercent !== undefined && (
                    <Typography variant="body2" color="text.secondary" mt={0.6}>{Number(position.floatingPnlPercent).toFixed(2)}%</Typography>
                  )}
                </PanelCard>
              </>
            )}
          </Stack>
        </Grid>
      </Grid>

      <Box sx={{ px: 2, py: 1.4, borderRadius: 3, bgcolor: "rgba(3,10,18,.82)", border: "1px solid rgba(148,163,184,.16)" }}>
        <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" gap={1.5}>
          <Typography variant="body2">UI STATE: <b>{uiState}</b></Typography>
          <Typography variant="body2">EXECUTORS: TREND {asRecord(processes.trend).alive ? "✓" : "—"} | SIDEWAY {asRecord(processes.sideway).alive ? "✓" : "—"}</Typography>
          <Typography variant="body2">RISK MODE: {accountMode}</Typography>
          <Typography variant="body2">TELEGRAM: {lifecycle.telegramReady ? "READY" : "CHECK"}</Typography>
          <Typography variant="body2">MT5 JOURNAL: {performanceQuery.data ? "READY" : "CHECK"}</Typography>
          <Typography variant="body2">PANEL ORDER PERMISSION: NONE</Typography>
        </Stack>
      </Box>
    </Stack>
  );
}
