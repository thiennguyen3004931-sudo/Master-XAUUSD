import { useMemo, useState, type ReactNode } from "react";
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
import { getPhase7CLifecycle } from "../api";
import { getPhase7CSameModeAccountChangeReadiness } from "../phase7c-account-switch-api";
import { maskMt5AccountLogin } from "../phase7c-account-switch";
import { getPhase7CLiveArmControlCapability } from "../phase7c-live-arm-control-api";
import { Phase7CAccountRiskAdvancedPanel } from "../ui/Phase7CAccountRiskAdvancedPanel";
import { Phase7CAccountRiskLotCard } from "../ui/Phase7CAccountRiskLotCard";
import { Phase7CAccountSwitchCard } from "../ui/Phase7CAccountSwitchCard";
import { Phase7COperatorStatusBar } from "../ui/Phase7COperatorStatusBar";
import { Phase7CStrategyEntryConditionsCard } from "../ui/Phase7CStrategyEntryConditionsCard";

const READINESS_LABELS: Record<string, string> = {
  botPaused: "Bot phải PAUSE",
  zeroXauusdPositions: "XAUUSD positions phải = 0",
  bridgeMatchesSelectedAccount: "Bridge phải đúng tài khoản",
  liveDisarmed: "LIVE phải DISARMED",
  noSwitchRunning: "Không được có account switch đang chạy",
};

function SafetyChip({ label, passed }: { label: string; passed: boolean }) {
  const status = passed ? "ĐẠT" : "CẦN XỬ LÝ";
  return (
    <Chip
      size="small"
      label={`${status} · ${label}`}
      color={passed ? "success" : "error"}
      variant="outlined"
      sx={{ fontWeight: 850 }}
    />
  );
}

function CurrentStateItem({ label, value, tone = "text.primary" }: { label: string; value: string; tone?: string }) {
  return (
    <Box
      sx={{
        minWidth: 0,
        p: 1.5,
        borderRadius: 3,
        border: "1px solid rgba(148,163,184,.14)",
        bgcolor: "rgba(15,23,42,.30)",
      }}
    >
      <Typography variant="caption" color="text.secondary" fontWeight={800}>{label}</Typography>
      <Typography mt={0.35} fontWeight={950} color={tone} noWrap>{value}</Typography>
    </Box>
  );
}

function DisclosureSection({
  title,
  subtitle,
  open,
  onToggle,
  children,
}: {
  title: string;
  subtitle: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <Card variant="outlined" sx={{ borderRadius: 4 }}>
      <CardContent sx={{ p: { xs: 2, md: 2.5 } }}>
        <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" gap={1.5} alignItems={{ md: "center" }}>
          <Box>
            <Typography variant="overline" color="primary" fontWeight={950}>{title}</Typography>
            <Typography variant="body2" color="text.secondary">{subtitle}</Typography>
          </Box>
          <Button variant="text" size="small" onClick={onToggle} sx={{ fontWeight: 900, alignSelf: { xs: "flex-start", md: "center" } }}>
            {open ? "Ẩn" : "Mở"}
          </Button>
        </Stack>
        {open ? <Box mt={2}>{children}</Box> : null}
      </CardContent>
    </Card>
  );
}

export function Phase7CAccountRiskPage() {
  const [accountSwitchOpen, setAccountSwitchOpen] = useState(false);
  const [riskEditorOpen, setRiskEditorOpen] = useState(false);
  const [strategyOpen, setStrategyOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const readinessQuery = useQuery({
    queryKey: ["phase7c-same-mode-account-change-readiness"],
    queryFn: getPhase7CSameModeAccountChangeReadiness,
    refetchInterval: 2_000,
    retry: false,
    placeholderData: (previous) => previous,
  });

  const liveArmCapabilityQuery = useQuery({
    queryKey: ["phase7c-live-arm-control-capability"],
    queryFn: getPhase7CLiveArmControlCapability,
    refetchInterval: 2_000,
    retry: false,
    placeholderData: (previous) => previous,
  });

  const lifecycleQuery = useQuery({
    queryKey: ["phase7c-lifecycle-current-state"],
    queryFn: getPhase7CLifecycle,
    refetchInterval: 2_000,
    retry: false,
    placeholderData: (previous) => previous,
  });

  const readiness = readinessQuery.data;
  const checks = readiness?.checks;
  const switchSafe = readiness?.approved === true;
  const readinessMode = readiness?.currentMode ?? "—";
  const login = readiness?.accountLogin ?? null;
  const server = readiness?.server ?? "MT5 server —";

  const liveArmCapability = liveArmCapabilityQuery.data;
  const lifecycle = lifecycleQuery.data;
  const currentAccountMode = liveArmCapability?.accountMode ?? readinessMode;
  const currentBotMode = liveArmCapability?.botMode ?? lifecycle?.mode.mode ?? "—";
  const currentLiveArmStatus = currentAccountMode === "LIVE"
    ? liveArmCapability?.liveArmStatus ?? "—"
    : "KHÔNG ÁP DỤNG";
  const currentLifecycleStatus = lifecycle
    ? lifecycle.running
      ? lifecycle.ready ? "RUNNING · READY" : "RUNNING · CHƯA READY"
      : "STOPPED"
    : "—";
  const currentOpenPositions = liveArmCapability
    ? String(liveArmCapability.openXauusdPositions)
    : "—";

  const safetyRows = useMemo(
    () => [
      ["botPaused", checks?.botPaused === true],
      ["zeroXauusdPositions", checks?.zeroXauusdPositions === true],
      ["bridgeMatchesSelectedAccount", checks?.bridgeMatchesSelectedAccount === true],
      ["liveDisarmed", readinessMode === "LIVE" ? checks?.liveDisarmed === true : true],
      ["noSwitchRunning", checks?.noSwitchRunning === true],
    ] as const,
    [checks, readinessMode],
  );

  const firstBlocked = safetyRows.find(([, passed]) => !passed)?.[0] ?? null;
  const blockedReason = firstBlocked ? READINESS_LABELS[firstBlocked] ?? firstBlocked : "Đang chờ readiness";
  const currentStateReadError = liveArmCapabilityQuery.isError || lifecycleQuery.isError;

  return (
    <Stack spacing={2.2}>
      <Box
        sx={{
          p: { xs: 2, md: 2.5 },
          borderRadius: 4,
          border: "1px solid rgba(148,163,184,.14)",
          bgcolor: "rgba(15,23,42,.40)",
        }}
      >
        <Typography variant="overline" color="primary" fontWeight={950}>ACCOUNT & RISK V2</Typography>
        <Typography variant="h4" fontWeight={950}>Tài khoản & Rủi ro</Typography>
        <Typography variant="body2" color="text.secondary" mt={0.6}>
          Theo dõi trạng thái vận hành thực tế, điều kiện đổi tài khoản và cấu hình rủi ro cho lệnh mới.
        </Typography>
      </Box>

      <Phase7COperatorStatusBar />

      <Card variant="outlined" sx={{ borderRadius: 4 }}>
        <CardContent sx={{ p: { xs: 2, md: 2.5 } }}>
          <Stack spacing={1.5}>
            <Box>
              <Typography variant="overline" color="primary" fontWeight={950}>TRẠNG THÁI HIỆN TẠI</Typography>
              <Typography variant="body2" color="text.secondary">
                Dữ liệu vận hành hiện tại từ lifecycle và canonical LIVE ARM capability. Không dùng readiness đổi tài khoản để suy diễn trạng thái này.
              </Typography>
            </Box>

            {currentStateReadError ? (
              <Alert severity="warning">
                Một phần trạng thái hiện tại chưa đọc được. Không suy diễn ARM hoặc Lifecycle từ checklist đổi tài khoản.
              </Alert>
            ) : null}

            <Grid container spacing={1.2}>
              <Grid size={{ xs: 12, sm: 6, lg: 2.4 }}>
                <CurrentStateItem label="Tài khoản hiện tại:" value={currentAccountMode} tone={currentAccountMode === "LIVE" ? "warning.main" : "success.main"} />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, lg: 2.4 }}>
                <CurrentStateItem label="Bot hiện tại:" value={currentBotMode} tone={currentBotMode === "PAUSE" ? "warning.main" : "success.main"} />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, lg: 2.4 }}>
                <CurrentStateItem label="LIVE ARM hiện tại:" value={currentLiveArmStatus} tone={currentLiveArmStatus === "ARMED" ? "success.main" : "warning.main"} />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, lg: 2.4 }}>
                <CurrentStateItem label="Lifecycle:" value={currentLifecycleStatus} tone={currentLifecycleStatus === "RUNNING · READY" ? "success.main" : "warning.main"} />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, lg: 2.4 }}>
                <CurrentStateItem label="Vị thế XAUUSD:" value={currentOpenPositions} tone={currentOpenPositions === "0" ? "success.main" : "warning.main"} />
              </Grid>
            </Grid>
          </Stack>
        </CardContent>
      </Card>

      {readinessQuery.isError ? (
        <Alert severity="warning">
          Không đọc được điều kiện đổi tài khoản: {readinessQuery.error instanceof Error ? readinessQuery.error.message : "lỗi không xác định"}
        </Alert>
      ) : (
        <Alert severity={switchSafe ? "success" : "warning"}>
          <Stack spacing={1}>
            <Typography variant="overline" fontWeight={950}>ĐIỀU KIỆN ĐỂ ĐỔI TÀI KHOẢN</Typography>
            <Typography fontWeight={950}>
              {switchSafe ? "ĐÃ ĐỦ ĐIỀU KIỆN ĐỔI TÀI KHOẢN" : "CHƯA ĐỦ ĐIỀU KIỆN ĐỔI TÀI KHOẢN"}
            </Typography>
            {!switchSafe ? (
              currentAccountMode === "LIVE" ? (
                <Typography variant="body2">
                  Hành động an toàn: chuyển Bot về PAUSE, sau đó DISARM LIVE; tiếp theo xử lý điều kiện còn thiếu: {blockedReason}.
                </Typography>
              ) : (
                <Typography variant="body2">Hành động cần làm: {blockedReason}.</Typography>
              )
            ) : null}
            <Stack direction="row" spacing={0.8} useFlexGap flexWrap="wrap">
              {safetyRows.map(([key, passed]) => (
                <SafetyChip key={key} label={READINESS_LABELS[key] ?? key} passed={passed} />
              ))}
            </Stack>
          </Stack>
        </Alert>
      )}

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, lg: 6 }}>
          <Card variant="outlined" sx={{ borderRadius: 4, height: "100%" }}>
            <CardContent sx={{ p: { xs: 2, md: 2.5 } }}>
              <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" gap={1.5}>
                <Box>
                  <Typography variant="overline" color="warning.main" fontWeight={950}>TÀI KHOẢN MT5</Typography>
                  <Typography variant="h5" fontWeight={950}>{currentAccountMode}</Typography>
                  <Typography variant="body2" color="text.secondary" mt={0.5}>
                    {login ? maskMt5AccountLogin(login) : "LOGIN —"} · {server}
                  </Typography>
                </Box>
                <Stack direction="row" spacing={0.8} useFlexGap flexWrap="wrap" alignContent="flex-start">
                  <Chip size="small" label={checks?.bridgeMatchesSelectedAccount ? "BRIDGE ĐẠT" : "BRIDGE CẦN KIỂM TRA"} color={checks?.bridgeMatchesSelectedAccount ? "success" : "warning"} variant="outlined" />
                  <Chip size="small" label={checks?.noSwitchRunning ? "SWITCH CONTROL RẢNH" : "SWITCH CONTROL BẬN"} color={checks?.noSwitchRunning ? "success" : "warning"} variant="outlined" />
                </Stack>
              </Stack>

              <Typography variant="body2" color="text.secondary" mt={2}>
                Nút đổi tài khoản dùng checklist “ĐIỀU KIỆN ĐỂ ĐỔI TÀI KHOẢN” phía trên. Việc đủ điều kiện đổi tài khoản không đồng nghĩa Bot đang PAUSE hoặc LIVE đang DISARMED sau khi thao tác hoàn tất.
              </Typography>

              <Button
                variant={accountSwitchOpen ? "outlined" : "contained"}
                onClick={() => setAccountSwitchOpen((value) => !value)}
                sx={{ mt: 2, fontWeight: 950 }}
              >
                {accountSwitchOpen ? "ẨN ĐỔI TÀI KHOẢN" : "ĐỔI TÀI KHOẢN"}
              </Button>

              {accountSwitchOpen ? (
                <Box mt={2}>
                  <Phase7CAccountSwitchCard />
                </Box>
              ) : null}
            </CardContent>
          </Card>
        </Grid>

        <Grid size={{ xs: 12, lg: 6 }}>
          <Phase7CAccountRiskLotCard
            editorOpen={riskEditorOpen}
            onToggleEditor={() => setRiskEditorOpen((value) => !value)}
          />
        </Grid>
      </Grid>

      <DisclosureSection
        title="ĐIỀU KIỆN VÀO LỆNH"
        subtitle="Trend · Sideway · Regime · các điều kiện chiến lược. Mặc định thu gọn để ưu tiên vận hành."
        open={strategyOpen}
        onToggle={() => setStrategyOpen((value) => !value)}
      >
        <Phase7CStrategyEntryConditionsCard />
      </DisclosureSection>

      <DisclosureSection
        title="CHẨN ĐOÁN / NÂNG CAO"
        subtitle="Runtime, Bridge, broker spec và telemetry kỹ thuật. Chỉ mở khi cần kiểm tra sâu."
        open={advancedOpen}
        onToggle={() => setAdvancedOpen((value) => !value)}
      >
        <Phase7CAccountRiskAdvancedPanel />
      </DisclosureSection>
    </Stack>
  );
}
