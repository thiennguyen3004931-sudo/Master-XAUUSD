import { Phase7CChartPatternAdvisorCard } from "../ui/Phase7CChartPatternAdvisorCard";
import type { ReactNode } from "react";
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
import { LoadingState, ErrorState } from "../ui/PageState";
import { Phase7COperatorStatusBar } from "../ui/Phase7COperatorStatusBar";
import {
  clean,
  compactReason,
  fetchPhase7CWebStatus,
  getTradeUiState,
  raw,
  stageTone,
  value,
  type Phase7CEntryCheck,
  type Phase7CUiGate,
} from "../phase7c-panel-status";

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function PanelCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <Card variant="outlined" sx={{ height: "100%", borderRadius: 4, bgcolor: "rgba(7,14,25,.72)" }}>
      <CardContent sx={{ p: { xs: 2, md: 2.6 } }}>
        <Typography variant="h6" fontWeight={950}>{title}</Typography>
        <Typography variant="body2" color="text.secondary" mt={0.5}>{subtitle}</Typography>
        <Box mt={1.8}>{children}</Box>
      </CardContent>
    </Card>
  );
}

function InfoRow({ label, valueText, tone = "default" }: { label: string; valueText: string; tone?: "default" | "success" | "warning" | "error" | "info" }) {
  const color = tone === "success" ? "success.main" : tone === "warning" ? "warning.main" : tone === "error" ? "error.main" : tone === "info" ? "info.main" : "text.primary";
  return (
    <Stack direction="row" justifyContent="space-between" gap={2} py={0.82} sx={{ borderBottom: "1px solid rgba(148,163,184,.08)" }}>
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Typography variant="body2" fontWeight={900} color={color} textAlign="right">{valueText}</Typography>
    </Stack>
  );
}

function gateLabel(gate: Phase7CUiGate | undefined) {
  if (gate === "ALLOWED") return "ĐƯỢC PHÉP";
  if (gate === "BLOCKED_BY_MODE") return "CHẶN DO MODE";
  if (gate === "BLOCKED_BY_REGIME") return "CHẶN DO REGIME";
  return "ĐANG CHỜ";
}

function gateTone(gate: Phase7CUiGate | undefined): "success" | "warning" | "default" {
  return gate === "ALLOWED" ? "success" : gate === "BLOCKED_BY_MODE" || gate === "BLOCKED_BY_REGIME" ? "warning" : "default";
}

function ReasonList({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <Typography variant="body2" color="text.secondary">{empty}</Typography>;
  return (
    <Stack spacing={1}>
      {items.slice(0, 6).map((item, index) => (
        <Typography key={`${index}-${item}`} variant="body2" lineHeight={1.55}>• {item}</Typography>
      ))}
    </Stack>
  );
}

function entryCheckTone(status: Phase7CEntryCheck["status"]): "success" | "error" | "warning" | "default" {
  if (status === "PASS") return "success";
  if (status === "FAIL" || status === "BLOCKED") return "error";
  if (status === "WAIT") return "warning";
  return "default";
}

function entryCheckLabel(status: Phase7CEntryCheck["status"]) {
  if (status === "PASS") return "ĐẠT";
  if (status === "FAIL") return "KHÔNG ĐẠT";
  if (status === "BLOCKED") return "BỊ CHẶN";
  return "ĐANG CHỜ";
}

function EntryPipeline({ checks }: { checks: Phase7CEntryCheck[] }) {
  if (checks.length === 0) {
    return <Alert severity="warning" variant="outlined">Engine chưa trả diagnostics structured cho strategy đang hoạt động.</Alert>;
  }

  const firstOpen = checks.findIndex((check) => check.status !== "PASS");

  return (
    <Stack spacing={1}>
      {checks.map((check, index) => {
        const isCurrent = firstOpen === index;
        return (
          <Box
            key={check.code}
            sx={{
              px: 1.4,
              py: 1.1,
              borderRadius: 2.4,
              border: isCurrent ? "1px solid rgba(245,158,11,.50)" : "1px solid rgba(148,163,184,.10)",
              bgcolor: isCurrent ? "rgba(245,158,11,.07)" : "rgba(15,23,42,.34)",
            }}
          >
            <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" gap={1} alignItems={{ sm: "center" }}>
              <Box sx={{ minWidth: 0 }}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Typography variant="body2" color="text.secondary" fontWeight={900}>{index + 1}</Typography>
                  <Typography variant="body2" fontWeight={950}>{check.label}</Typography>
                  {isCurrent ? <Chip label="BƯỚC HIỆN TẠI" size="small" color="warning" variant="outlined" sx={{ fontWeight: 900 }} /> : null}
                </Stack>
                <Typography variant="caption" color="text.secondary" display="block" mt={0.35}>
                  {check.reason}
                </Typography>
              </Box>
              <Chip
                label={entryCheckLabel(check.status)}
                size="small"
                color={entryCheckTone(check.status)}
                variant={check.status === "PASS" ? "outlined" : "filled"}
                sx={{ fontWeight: 950, minWidth: 94, alignSelf: { xs: "flex-start", sm: "center" } }}
              />
            </Stack>
          </Box>
        );
      })}
    </Stack>
  );
}

function TechnicalEntryChecks({ title, checks }: { title: string; checks: Phase7CEntryCheck[] }) {
  return (
    <Box>
      <Typography variant="subtitle2" fontWeight={950} mb={0.8}>{title}</Typography>
      {checks.length === 0 ? (
        <Typography variant="body2" color="text.secondary">Chưa có diagnostics structured.</Typography>
      ) : (
        <Stack spacing={0.8}>
          {checks.map((check) => (
            <Box key={check.code} sx={{ px: 1.2, py: 0.9, borderRadius: 2, bgcolor: "rgba(15,23,42,.30)" }}>
              <Stack direction="row" justifyContent="space-between" gap={1}>
                <Typography variant="body2" fontWeight={900}>{check.code} · {check.label}</Typography>
                <Typography variant="body2" fontWeight={900} color={`${entryCheckTone(check.status)}.main`}>
                  {entryCheckLabel(check.status)}
                </Typography>
              </Stack>
              <Typography variant="caption" color="text.secondary" display="block">
                Actual: {check.actual} · Required: {check.required}
              </Typography>
              <Typography variant="caption" color="text.secondary" display="block">{check.reason}</Typography>
            </Box>
          ))}
        </Stack>
      )}
    </Box>
  );
}

function ContractLine({ children }: { children: ReactNode }) {
  return <Typography variant="body2" color="text.secondary" lineHeight={1.55}>• {children}</Typography>;
}

function uiStateLabel(uiState: "WAITING" | "SETUP_READY" | "MANAGING") {
  if (uiState === "SETUP_READY") return "SETUP ĐÃ ĐƯỢC DUYỆT";
  if (uiState === "MANAGING") return "ĐANG QUẢN LÝ LỆNH LIVE";
  return "ĐANG CHỜ TÍN HIỆU";
}

export function Phase7BPatternCheckPage() {
  const query = useQuery({
    queryKey: ["phase7c-web-status-signal-v7-operator-flow"],
    queryFn: fetchPhase7CWebStatus,
    refetchInterval: 3_000,
    retry: false,
    placeholderData: (previous) => previous,
  });

  if (query.isLoading) return <LoadingState />;
  if (query.isError && !query.data) {
    return <ErrorState message={query.error instanceof Error ? query.error.message : "Không đọc được tín hiệu Phase7C."} />;
  }

  const data = query.data;
  const panel = data?.panel;
  const ui = data?.ui;
  const accountRisk = asRecord(data?.accountRisk);
  const quote = asRecord(accountRisk.quote);

  const uiState = getTradeUiState(panel, ui);
  const approved = ui?.approved ?? raw(panel, "approved") === "true";
  const stage = clean(ui?.stage, value(panel, "stage", "—"));
  const regime = clean(ui?.regime, value(panel, "regime", "—"));
  const activeMode = clean(ui?.mode, value(panel, "activeMode", "—"));
  const strategy = clean(ui?.effectiveStrategy, value(panel, "effectiveStrategy", "—"));
  const confidence = clean(ui?.confidence, value(panel, "confidence", "—"));
  const recommendedMode = clean(ui?.recommendedMode, value(panel, "recommendedMode", "—"));

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

  const setup = ui?.setup;
  const position = ui?.position;
  const trendChecks = ui?.entryChecks?.trend ?? [];
  const sidewayChecks = ui?.entryChecks?.sideway ?? [];
  const normalizedStrategy = strategy.toUpperCase();
  const activeStrategy = normalizedStrategy.includes("TREND") ? "TREND" : normalizedStrategy.includes("SIDEWAY") ? "SIDEWAY" : "—";
  const inactiveStrategy = activeStrategy === "TREND" ? "SIDEWAY" : activeStrategy === "SIDEWAY" ? "TREND" : "—";
  const activeChecks = activeStrategy === "TREND" ? trendChecks : activeStrategy === "SIDEWAY" ? sidewayChecks : [];
  const activeGate = activeStrategy === "TREND" ? ui?.gates.trend : activeStrategy === "SIDEWAY" ? ui?.gates.sideway : undefined;
  const inactiveGate = activeStrategy === "TREND" ? ui?.gates.sideway : activeStrategy === "SIDEWAY" ? ui?.gates.trend : undefined;
  const operatorSide = clean(position?.side ?? setup?.side ?? raw(panel, "side"), "Chưa xác định");
  const operatorLot = clean(position?.volume ?? setup?.finalLot ?? raw(panel, "finalLot"), "—");

  const currentReasonTitle = uiState === "WAITING"
    ? "LÝ DO CHƯA VÀO LỆNH"
    : uiState === "SETUP_READY"
      ? "LÝ DO SETUP ĐƯỢC DUYỆT"
      : "LÝ DO LỆNH ĐANG ĐƯỢC QUẢN LÝ";
  const currentReasons = uiState === "WAITING" ? waitReasons : uiState === "SETUP_READY" ? entryReasons : holdReasons;

  return (
    <Stack spacing={2.2}>
      <Box sx={{ p: { xs: 2, md: 2.6 }, borderRadius: 4, border: "1px solid rgba(0,213,255,.18)", bgcolor: "rgba(3,10,18,.82)" }}>
        <Stack direction={{ xs: "column", lg: "row" }} justifyContent="space-between" gap={2} alignItems={{ lg: "center" }}>
          <Box>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography variant="h4" fontWeight={950}>Tín hiệu & quyết định</Typography>
              <Chip label="SIGNAL UI V3" size="small" color="info" variant="outlined" sx={{ fontWeight: 950 }} />
              <Chip label="OPERATOR DECISION FLOW" size="small" variant="outlined" sx={{ fontWeight: 900 }} />
            </Stack>
            <Typography variant="body2" color="text.secondary" mt={0.7}>
              Ưu tiên câu trả lời vận hành: Bot đang làm gì → đang chờ gate nào → vì sao → kế hoạch/vị thế thật. Không tự thêm indicator nếu engine không trả về.
            </Typography>
          </Box>
          <Stack direction="row" spacing={0.8} flexWrap="wrap" useFlexGap>
            <Chip label={`Mode ${activeMode}`} variant="outlined" color={activeMode === "PAUSE" ? "warning" : "success"} sx={{ fontWeight: 900 }} />
            <Chip label={`Stage ${stage}`} variant="outlined" color={stageTone(stage)} sx={{ fontWeight: 900 }} />
            <Chip label={`Regime ${regime}`} variant="outlined" color={regime === "REVERSAL" ? "warning" : "info"} sx={{ fontWeight: 900 }} />
            <Chip label={`Conf ${confidence}%`} variant="outlined" sx={{ fontWeight: 900 }} />
          </Stack>
        </Stack>
      </Box>

      <Phase7COperatorStatusBar />

      {data?.usedDirectFallback ? (
        <Box sx={{ px: 1.6, py: 0.9, borderRadius: 2.5, border: "1px solid rgba(56,189,248,.18)", bgcolor: "rgba(56,189,248,.05)" }}>
          <Typography variant="caption" color="text.secondary">Data path: fallback trực tiếp Control API 3711; nội dung giao dịch vẫn lấy từ semantic contract.</Typography>
        </Box>
      ) : null}
      {(data?.errors ?? []).length > 0 ? <Alert severity="warning">Nguồn phụ chưa sẵn sàng: {(data?.errors ?? []).slice(0, 2).join(" ")}</Alert> : null}

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, lg: 8 }}>
          <PanelCard title="BOT ĐANG LÀM GÌ?" subtitle="Trạng thái hành động chính từ semantic runtime, không lặp lại một card UI State/Decision riêng.">
            <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" gap={2.2} alignItems={{ md: "center" }}>
              <Box>
                <Typography variant="h4" fontWeight={950} color={uiState === "WAITING" ? "warning.main" : "success.main"}>
                  {uiStateLabel(uiState)}
                </Typography>
                <Typography variant="body2" color="text.secondary" mt={0.8}>
                  {activeMode} → {strategy} · Stage {stage} · Approved {approved ? "Có" : "Không"}
                </Typography>
              </Box>
              <Grid container spacing={1} sx={{ minWidth: { md: 380 } }}>
                <Grid size={4}><InfoRow label="Strategy" valueText={strategy} tone="info" /></Grid>
                <Grid size={4}><InfoRow label="Direction" valueText={operatorSide} /></Grid>
                <Grid size={4}><InfoRow label="Lot" valueText={operatorLot} /></Grid>
              </Grid>
            </Stack>
          </PanelCard>
        </Grid>
        <Grid size={{ xs: 12, lg: 4 }}>
          <PanelCard title="THỊ TRƯỜNG & GIÁ" subtitle="Classifier + quote hiện tại từ MT5.">
            <Stack direction="row" justifyContent="space-between" gap={2} alignItems="flex-start">
              <Box>
                <Typography variant="h4" fontWeight={950}>{regime}</Typography>
                <Typography variant="body2" color="text.secondary">Confidence {confidence}% · Recommended {recommendedMode}</Typography>
              </Box>
              <Box textAlign="right">
                <Typography variant="h5" fontWeight={950}>{clean(quote.bid, "—")}</Typography>
                <Typography variant="caption" color="text.secondary" display="block">Bid</Typography>
              </Box>
            </Stack>
            <InfoRow label="Ask" valueText={clean(quote.ask, "—")} />
            <InfoRow label="Spread" valueText={clean(quote.spread, "—")} />
          </PanelCard>
        </Grid>
      </Grid>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, lg: 7 }}>
          <PanelCard title="ĐANG CHỜ ĐIỀU KIỆN NÀO?" subtitle={`Pipeline ${activeStrategy} từ diagnostics canonical. Bước đầu tiên chưa PASS được đánh dấu là bước hiện tại.`}>
            <Stack direction="row" spacing={0.8} useFlexGap flexWrap="wrap" mb={1.4}>
              <Chip label={`${activeStrategy} · ${gateLabel(activeGate)}`} color={gateTone(activeGate)} variant="outlined" sx={{ fontWeight: 950 }} />
              <Chip label={`Reversal filter · ${ui?.gates.reversalFilter === "BLOCKING" ? "ĐANG CHẶN" : "CLEAR"}`} color={ui?.gates.reversalFilter === "BLOCKING" ? "warning" : "success"} variant="outlined" sx={{ fontWeight: 900 }} />
            </Stack>
            <EntryPipeline checks={activeChecks} />
          </PanelCard>
        </Grid>
        <Grid size={{ xs: 12, lg: 5 }}>
          <PanelCard title={currentReasonTitle} subtitle="Reason người vận hành cần đọc trước; raw code/actual/required chuyển xuống Chi tiết kỹ thuật.">
            <ReasonList items={currentReasons} empty="Chưa có reason runtime để hiển thị." />
          </PanelCard>
        </Grid>
      </Grid>

      <Phase7CChartPatternAdvisorCard />

      <PanelCard title="CHIẾN LƯỢC ĐANG HOẠT ĐỘNG" subtitle="Chỉ strategy hiệu lực được ưu tiên; strategy còn lại thu gọn theo gate hiện tại.">
        <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" gap={2} alignItems={{ md: "center" }}>
          <Box>
            <Typography variant="overline" color={activeStrategy === "—" ? "warning.main" : "success.main"} fontWeight={950}>
              {activeStrategy === "—" ? "CHƯA XÁC ĐỊNH" : "ACTIVE"}
            </Typography>
            <Typography variant="h5" fontWeight={950}>{activeStrategy}</Typography>
            <Typography variant="body2" color="text.secondary" mt={0.5}>
              Effective strategy: {strategy} · Gate: {activeStrategy === "—" ? "CHƯA CÓ DỮ LIỆU" : gateLabel(activeGate)}
            </Typography>
          </Box>
          <Box sx={{ px: 1.6, py: 1.2, borderRadius: 2.5, border: "1px solid rgba(148,163,184,.12)", minWidth: { md: 310 } }}>
            <Typography variant="overline" color="text.secondary" fontWeight={900}>KHÔNG HOẠT ĐỘNG</Typography>
            <Typography variant="body1" fontWeight={950}>{inactiveStrategy}</Typography>
            <Typography variant="body2" color="text.secondary">
              {inactiveStrategy === "—" ? "Chưa xác định từ semantic runtime" : gateLabel(inactiveGate)}
            </Typography>
          </Box>
        </Stack>
      </PanelCard>

      <PanelCard
        title={uiState === "WAITING" ? "KẾ HOẠCH LỆNH — CHƯA ĐƯỢC DUYỆT" : uiState === "SETUP_READY" ? "KẾ HOẠCH LỆNH ĐÃ ĐƯỢC DUYỆT" : "VỊ THẾ ĐANG QUẢN LÝ"}
        subtitle={uiState === "WAITING" ? "Không dựng Entry / SL / TP khi semantic setup chưa tồn tại." : "Chỉ hiển thị giá trị thật từ semantic contract."}
      >
        {uiState === "WAITING" ? (
          <Stack spacing={1.2}>
            <Alert severity="warning" variant="outlined">Bot đang chờ setup hợp lệ. Entry / Stoploss / TP chưa được engine phê duyệt nên không hiển thị giá giả định.</Alert>
            <Grid container spacing={1.2}>
              <Grid size={{ xs: 12, sm: 4 }}><InfoRow label="Strategy" valueText={strategy} /></Grid>
              <Grid size={{ xs: 12, sm: 4 }}><InfoRow label="Side" valueText={operatorSide} /></Grid>
              <Grid size={{ xs: 12, sm: 4 }}><InfoRow label="Lot hiện hành" valueText={operatorLot} /></Grid>
            </Grid>
          </Stack>
        ) : uiState === "SETUP_READY" ? (
          <Grid container spacing={1.5}>
            <Grid size={{ xs: 12, md: 4 }}><InfoRow label="Strategy" valueText={clean(setup?.strategy, strategy)} /></Grid>
            <Grid size={{ xs: 12, md: 4 }}><InfoRow label="Side" valueText={clean(setup?.side, "—")} /></Grid>
            <Grid size={{ xs: 12, md: 4 }}><InfoRow label="Setup" valueText={clean(setup?.name, "—")} /></Grid>
            <Grid size={{ xs: 12, md: 4 }}><InfoRow label="Entry" valueText={clean(setup?.entry, "—")} tone="info" /></Grid>
            <Grid size={{ xs: 12, md: 4 }}><InfoRow label="Stoploss" valueText={clean(setup?.stopLoss, "—")} tone="error" /></Grid>
            <Grid size={{ xs: 12, md: 4 }}><InfoRow label="TP1 / TP2" valueText={`${clean(setup?.tp1, "—")} / ${clean(setup?.tp2, "—")}`} tone="success" /></Grid>
            <Grid size={{ xs: 12, md: 4 }}><InfoRow label="Lot" valueText={clean(setup?.finalLot, "—")} /></Grid>
            <Grid size={{ xs: 12, md: 4 }}><InfoRow label="Risk %" valueText={clean(setup?.estimatedRiskPercent, "—")} /></Grid>
          </Grid>
        ) : (
          <Stack spacing={1.4}>
            <Grid container spacing={1.5}>
              <Grid size={{ xs: 12, md: 4 }}><InfoRow label="Ticket" valueText={clean(position?.ticket, "—")} /></Grid>
              <Grid size={{ xs: 12, md: 4 }}><InfoRow label="Strategy" valueText={clean(position?.strategy, "—")} /></Grid>
              <Grid size={{ xs: 12, md: 4 }}><InfoRow label="Side / Volume" valueText={`${clean(position?.side, "—")} / ${clean(position?.volume, "—")}`} /></Grid>
              <Grid size={{ xs: 12, md: 4 }}><InfoRow label="Entry" valueText={clean(position?.entry, "—")} tone="info" /></Grid>
              <Grid size={{ xs: 12, md: 4 }}><InfoRow label="Current SL" valueText={clean(position?.stopLoss, "—")} tone="error" /></Grid>
              <Grid size={{ xs: 12, md: 4 }}><InfoRow label="TP1 / TP2" valueText={`${clean(position?.tp1, "—")} / ${clean(position?.tp2, "—")}`} tone="success" /></Grid>
              <Grid size={{ xs: 12, md: 4 }}><InfoRow label="Floating P/L USD" valueText={clean(position?.floatingPnlUsd, "—")} tone="info" /></Grid>
              <Grid size={{ xs: 12, md: 4 }}><InfoRow label="Floating P/L %" valueText={clean(position?.floatingPnlPercent, "—")} /></Grid>
            </Grid>
            <Alert severity="info" variant="outlined">
              Semantic UI hiện chưa expose trạng thái riêng cho từng mốc +6 BE / +10 partial / Fastmove / M5 structure trailing; V3 không suy diễn các badge quản lý này.
            </Alert>
          </Stack>
        )}
      </PanelCard>

      <Card variant="outlined" sx={{ borderRadius: 4, bgcolor: "rgba(7,14,25,.58)" }}>
        <CardContent sx={{ p: { xs: 2, md: 2.6 } }}>
          <details>
            <summary style={{ cursor: "pointer", fontWeight: 900 }}>
              CHI TIẾT KỸ THUẬT — gates, raw reasons, diagnostics và strategy contract
            </summary>
            <Box mt={2}>
              <Grid container spacing={2}>
                <Grid size={{ xs: 12, lg: 4 }}>
                  <Typography variant="subtitle1" fontWeight={950}>RUNTIME GATE / FILTER</Typography>
                  <InfoRow label="Trend gate" valueText={gateLabel(ui?.gates.trend)} tone={gateTone(ui?.gates.trend)} />
                  <InfoRow label="Sideway gate" valueText={gateLabel(ui?.gates.sideway)} tone={gateTone(ui?.gates.sideway)} />
                  <InfoRow label="Reversal filter" valueText={ui?.gates.reversalFilter === "BLOCKING" ? "ĐANG CHẶN" : "CLEAR"} tone={ui?.gates.reversalFilter === "BLOCKING" ? "warning" : "success"} />
                  <InfoRow label="Recommended mode" valueText={recommendedMode} />
                  <Typography variant="caption" color="text.secondary" display="block" mt={1.2}>decisionReason: {clean(raw(panel, "decisionReason"), "—")}</Typography>
                  <Typography variant="caption" color="text.secondary" display="block">entryReason: {clean(raw(panel, "entryReason"), "—")}</Typography>
                  <Typography variant="caption" color="text.secondary" display="block">holdReason: {clean(raw(panel, "holdReason"), "—")}</Typography>
                </Grid>
                <Grid size={{ xs: 12, lg: 4 }}>
                  <TechnicalEntryChecks title="TREND DIAGNOSTICS" checks={trendChecks} />
                </Grid>
                <Grid size={{ xs: 12, lg: 4 }}>
                  <TechnicalEntryChecks title="SIDEWAY DIAGNOSTICS" checks={sidewayChecks} />
                </Grid>
              </Grid>

              <Grid container spacing={2} mt={0.5}>
                <Grid size={{ xs: 12, lg: 4 }}>
                  <Typography variant="subtitle2" fontWeight={950} mb={0.8}>TREND CONTRACT</Typography>
                  <ContractLine>Regime và Mode phải cho phép Trend executor.</ContractLine>
                  <ContractLine>Signal engine phải xác nhận setup M15 hợp lệ và các filter hiện hành phải PASS.</ContractLine>
                  <ContractLine>Stoploss cấu trúc hợp lệ; vùng chuẩn 6–10 giá.</ContractLine>
                  <ContractLine>Nếu SL &gt; 10 giá: không vào đuổi, chuyển sang chờ pullback M15.</ContractLine>
                </Grid>
                <Grid size={{ xs: 12, lg: 4 }}>
                  <Typography variant="subtitle2" fontWeight={950} mb={0.8}>SIDEWAY CONTRACT</Typography>
                  <ContractLine>Regime và Mode phải cho phép Sideway executor.</ContractLine>
                  <ContractLine>Phải có supply/demand range và setup phản ứng hợp lệ.</ContractLine>
                  <ContractLine>Risk calculation phải PASS và lot không vượt Sideway Max Lot.</ContractLine>
                  <ContractLine>Quản trị chuẩn: +6 → BE; +10 → chốt 1/3.</ContractLine>
                </Grid>
                <Grid size={{ xs: 12, lg: 4 }}>
                  <Typography variant="subtitle2" fontWeight={950} mb={0.8}>REVERSAL FILTER</Typography>
                  <ContractLine>Filter bảo vệ có thể chặn lệnh mới khi rủi ro đảo chiều mạnh.</ContractLine>
                  <ContractLine>Semantic runtime quyết định BLOCKING/CLEAR và recommended mode.</ContractLine>
                  <ContractLine>Trang này chỉ đọc trạng thái; không gửi lệnh hoặc mutation control.</ContractLine>
                </Grid>
              </Grid>
            </Box>
          </details>
        </CardContent>
      </Card>
    </Stack>
  );
}
