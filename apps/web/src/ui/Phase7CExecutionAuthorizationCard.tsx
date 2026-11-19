import { useNow } from "../use-now";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Stack,
  Typography,
} from "@mui/material";
import {
  createPhase7CLiveArmPreflight,
  enablePhase7CAuto,
  executePhase7CLiveArmAction,
  getPhase7CAutoActivationStatus,
  getPhase7CLiveArmControlCapability,
  getPhase7CLiveArmControlStatus,
  type Phase7CLiveArmAction,
  type Phase7CLiveArmPreflight,
} from "../phase7c-execution-control";

const CHECK_LABELS: Record<string, string> = {
  controlEnabled: "Local Web control enabled",
  accountStateValid: "Tài khoản hợp lệ",
  botPaused: "Bot đang Tạm dừng",
  runtimeReady: "Executors + Telegram + lot profile Sẵn sàng",
  bridgeReachable: "MT5 Bridge kết nối",
  bridgeMatchesSelectedAccount: "Bridge khớp account đã chọn",
  brokerIsReal: "Broker account là LIVE/REAL",
  tradingEnabled: "Bridge trading enabled",
  terminalTradeAllowed: "MT5 terminal cho phép trading",
  expertTradeAllowed: "MT5 Algo/Expert Trading bật",
  zeroXauusdPositions: "XAUUSD positions = 0",
  zeroXauusdPendingOrders: "XAUUSD pending orders = 0",
  runtimeSourceExact: "Runtime source = EXACT_MATCH",
  bridgeSessionAvailable: "Bridge session hợp lệ",
  currentlyDisarmed: "LIVE hiện DISARMED",
  currentlyArmed: "LIVE hiện ARMED",
  noControlRunning: "Không có ARM request khác đang chạy",
  selectedLiveAccount: "Account đang chọn là LIVE",
  liveArmSatisfied: "LIVE ARM đã hợp lệ",
};

function checkCount(checks: Record<string, boolean> | undefined) {
  const entries = Object.entries(checks ?? {});
  return {
    passed: entries.filter(([, value]) => value).length,
    total: entries.length,
    entries,
  };
}

function CheckRows({ entries }: { entries: Array<[string, boolean]> }) {
  return (
    <Stack spacing={0.65}>
      {entries.map(([key, passed]) => (
        <Stack key={key} direction="row" justifyContent="space-between" gap={2}>
          <Typography variant="body2" color="text.secondary">
            {CHECK_LABELS[key] ?? key}
          </Typography>
          <Typography variant="body2" fontWeight={900} color={passed ? "success.main" : "error.main"}>
            {passed ? "Đạt" : "BLOCK"}
          </Typography>
        </Stack>
      ))}
    </Stack>
  );
}

function firstReason(keys: string[] | undefined, fallback: string) {
  const key = keys?.[0];
  return key ? CHECK_LABELS[key] ?? key : fallback;
}

export function Phase7CExecutionAuthorizationCard() {
  const now = useNow();
  const queryClient = useQueryClient();
  const [armRequestId, setArmRequestId] = useState<string | null>(null);
  const [armPreflight, setArmPreflight] = useState<Phase7CLiveArmPreflight | null>(null);
  const [armDetailsOpen, setArmDetailsOpen] = useState(false);
  const [showAutoChecks, setShowAutoChecks] = useState(false);

  const capability = useQuery({
    queryKey: ["phase7c-live-arm-control-capability"],
    queryFn: getPhase7CLiveArmControlCapability,
    refetchInterval: armRequestId ? false : 3_000,
    retry: false,
  });

  const autoStatus = useQuery({
    queryKey: ["phase7c-auto-activation-status"],
    queryFn: getPhase7CAutoActivationStatus,
    refetchInterval: 3_000,
    retry: false,
  });

  const armPreflightMutation = useMutation({
    mutationFn: () => createPhase7CLiveArmPreflight("ARM_LIVE"),
    onMutate: () => {
      setArmPreflight(null);
      setArmDetailsOpen(false);
    },
    onSuccess: (result) => setArmPreflight(result),
  });

  const armMutation = useMutation({
    mutationFn: async (action: Phase7CLiveArmAction) => {
      let preflight: Phase7CLiveArmPreflight;
      if (action === "ARM_LIVE") {
        if (!armPreflight?.approved || !armPreflight.preflightToken) {
          throw new Error("Hãy chạy Kiểm tra điều kiện ARM LIVE và bảo đảm kết quả PASS trước khi ARM.");
        }
        if (
          armPreflight.bridgeSessionId !== capability.data?.bridgeSessionId ||
          (armPreflight.expiresAt !== null && Date.now() >= armPreflight.expiresAt)
        ) {
          throw new Error("Kết quả kiểm tra ARM LIVE đã hết hiệu lực hoặc bridge session đã thay đổi. Hãy kiểm tra lại.");
        }
        preflight = armPreflight;
      } else {
        preflight = await createPhase7CLiveArmPreflight("DISARM_LIVE");
        if (!preflight.approved || !preflight.preflightToken) {
          throw new Error(`DISARM LIVE bị khóa: ${preflight.blockedBy.join(", ") || "UNKNOWN"}.`);
        }
      }

      const message = action === "ARM_LIVE"
        ? "Xác nhận ARM tài khoản LIVE cho đúng bridge session hiện tại? Bot phải đang PAUSE; thao tác này không tự bật AUTO và không gửi order."
        : "Xác nhận DISARM LIVE? Thao tác này thu hồi quyền mở lệnh mới và không đóng vị thế đang có.";
      if (!window.confirm(message)) throw new Error("Đã hủy thao tác theo yêu cầu người vận hành.");
      return executePhase7CLiveArmAction(action, preflight.preflightToken!);
    },
    onSuccess: (result) => {
      setArmRequestId(result.requestId);
      setArmPreflight(null);
      setArmDetailsOpen(false);
    },
  });

  const armStatus = useQuery({
    queryKey: ["phase7c-live-arm-control-status", armRequestId],
    queryFn: () => getPhase7CLiveArmControlStatus(armRequestId ?? ""),
    enabled: Boolean(armRequestId),
    refetchInterval: (query) => {
      const state = query.state.data;
      return state?.status === "PASS" || state?.status === "FAIL" ? false : 1_500;
    },
    retry: false,
  });

  const autoMutation = useMutation({
    mutationFn: enablePhase7CAuto,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["phase7c-auto-activation-status"] }),
        queryClient.invalidateQueries({ queryKey: ["phase7c-lifecycle"] }),
        queryClient.invalidateQueries({ queryKey: ["phase7c-decision-monitor"] }),
      ]);
    },
  });

  const controlDone = armStatus.data?.status === "PASS" || armStatus.data?.status === "FAIL";
  if (controlDone && capability.data && armRequestId) {
    queueMicrotask(() => {
      setArmRequestId(null);
      setArmPreflight(null);
      setArmDetailsOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["phase7c-live-arm-control-capability"] });
      void queryClient.invalidateQueries({ queryKey: ["phase7c-auto-activation-status"] });
      void queryClient.invalidateQueries({ queryKey: ["phase7c-lifecycle"] });
    });
  }

  const accountMode = capability.data?.accountMode ?? autoStatus.data?.accountMode ?? "DEMO";
  const botMode = autoStatus.data?.botMode ?? capability.data?.botMode ?? "—";
  const isAutoActive = botMode === "AUTO";
  const showAutoActivationDiagnostics = !isAutoActive;
  const autoStatusLabel = isAutoActive
    ? "ĐANG HOẠT ĐỘNG"
    : autoStatus.data?.approved
      ? "READY"
      : "BLOCKED";
  const armed = capability.data?.liveExecutionArmed === true;
  const canAttemptAuto = !isAutoActive && !autoMutation.isPending;
  const armCapabilityCount = checkCount(capability.data?.armChecks);
  const armPreflightCount = checkCount(armPreflight?.checks);
  const armBlockedBy = armPreflight?.blockedBy ?? capability.data?.armBlockedBy ?? [];
  const armReason = armed
    ? "LIVE đã ARMED cho bridge session hiện tại"
    : armPreflight?.approved
      ? "Điều kiện ARM LIVE đã đạt; token có hiệu lực ngắn hạn"
      : firstReason(
          armBlockedBy,
          capability.data?.canArm ? "Sẵn sàng chạy kiểm tra ARM LIVE" : "Đang đọc điều kiện ARM LIVE",
        );
  const autoChecks = accountMode === "DEMO"
    ? Object.fromEntries(
        Object.entries(autoStatus.data?.checks ?? {}).filter(([key]) => key !== "liveArmSatisfied"),
      )
    : autoStatus.data?.checks;
  const autoCount = checkCount(autoChecks);
  const autoBlockedBy = (autoStatus.data?.blockedBy ?? []).filter(
    (key) => !(accountMode === "DEMO" && key === "liveArmSatisfied"),
  );
  const autoReason = isAutoActive
    ? "AUTO đang hoạt động"
    : autoStatus.data?.approved
      ? "Tất cả điều kiện AUTO đã đạt"
      : firstReason(autoBlockedBy, "Đang đọc điều kiện AUTO");
  const armPreflightReady = Boolean(
    armPreflight?.approved &&
    armPreflight.preflightToken &&
    armPreflight.bridgeSessionId === capability.data?.bridgeSessionId &&
    (armPreflight.expiresAt === null || now < armPreflight.expiresAt),
  );

  return (
    <Card
      variant="outlined"
      sx={{
        borderRadius: 4,
        borderColor: accountMode === "LIVE" ? "warning.main" : "success.main",
        height: "100%",
      }}
    >
      <CardContent sx={{ p: { xs: 1.8, md: 2.1 } }}>
        <Stack spacing={1.5}>
          <Stack direction="row" justifyContent="space-between" gap={1.2} alignItems="flex-start">
            <Box>
              <Typography variant="overline" color={accountMode === "LIVE" ? "warning.main" : "success.main"} fontWeight={950}>
                EXECUTION AUTHORIZATION
              </Typography>
              <Typography variant="h6" fontWeight={950}>Ủy quyền giao dịch</Typography>
              {accountMode === "DEMO" ? (
                <Typography variant="caption" color="text.secondary">
                  DEMO chỉ dùng AUTO safety guard; không có thao tác ủy quyền LIVE.
                </Typography>
              ) : null}
            </Box>
            <Stack direction="row" spacing={0.7} useFlexGap flexWrap="wrap" justifyContent="flex-end">
              {accountMode === "LIVE" ? (
                <Chip
                  label={armed ? "LIVE · ARMED" : "LIVE · DISARMED"}
                  color={armed ? "success" : "error"}
                  size="small"
                  variant={armed ? "filled" : "outlined"}
                  sx={{ fontWeight: 950 }}
                />
              ) : (
                <Chip label="DEMO" color="success" size="small" variant="outlined" sx={{ fontWeight: 950 }} />
              )}
              <Chip
                label={`AUTO · ${autoStatusLabel}`}
                color={isAutoActive || autoStatus.data?.approved ? "success" : "warning"}
                size="small"
                variant="outlined"
                sx={{ fontWeight: 900 }}
              />
            </Stack>
          </Stack>

          {accountMode === "LIVE" ? (
            <Box sx={{ p: 1.35, borderRadius: 2.5, bgcolor: "rgba(15,23,42,.28)", border: "1px solid rgba(148,163,184,.14)" }}>
              <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" gap={1.1} alignItems={{ sm: "center" }}>
                <Box sx={{ minWidth: 0 }}>
                  <Stack direction="row" spacing={0.7} alignItems="center" useFlexGap flexWrap="wrap">
                    <Typography fontWeight={950}>LIVE ARM</Typography>
                    <Chip label={armed ? "ARMED" : armPreflight?.approved ? "READY" : "BLOCKED"} color={armed || armPreflight?.approved ? "success" : "warning"} size="small" />
                    {armPreflight ? (
                      <Chip label={`${armPreflightCount.passed}/${armPreflightCount.total} đạt`} size="small" variant="outlined" />
                    ) : (
                      <Chip label={`${armCapabilityCount.passed}/${armCapabilityCount.total} đạt`} size="small" variant="outlined" />
                    )}
                  </Stack>
                  <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.45 }}>
                    Lý do: {armReason}
                  </Typography>
                </Box>
                <Stack direction="row" spacing={0.7} useFlexGap flexWrap="wrap">
                  {!armed ? (
                    <Button
                      size="small"
                      variant="outlined"
                      disabled={armPreflightMutation.isPending || armMutation.isPending || Boolean(armRequestId) || !capability.data?.taskInstalled}
                      onClick={() => armPreflightMutation.mutate()}
                      sx={{ fontWeight: 900 }}
                    >
                      {armPreflightMutation.isPending ? "ĐANG KIỂM TRA..." : "KIỂM TRA ĐIỀU KIỆN ARM LIVE"}
                    </Button>
                  ) : null}
                  <Button
                    size="small"
                    variant={armed ? "outlined" : "contained"}
                    color={armed ? "error" : "success"}
                    disabled={armMutation.isPending || Boolean(armRequestId) || !capability.data?.taskInstalled || (!armed && !armPreflightReady)}
                    onClick={() => armMutation.mutate(armed ? "DISARM_LIVE" : "ARM_LIVE")}
                    sx={{ fontWeight: 950 }}
                  >
                    {armMutation.isPending ? "ĐANG XỬ LÝ..." : armed ? "DISARM LIVE" : "ARM LIVE"}
                  </Button>
                  <Button size="small" variant="text" onClick={() => setArmDetailsOpen((value) => !value)} sx={{ fontWeight: 900 }}>
                    {armDetailsOpen ? "Ẩn chi tiết" : "Xem chi tiết"}
                  </Button>
                </Stack>
              </Stack>

              {armDetailsOpen ? (
                <Box mt={1.1} pt={1.1} sx={{ borderTop: "1px solid rgba(148,163,184,.14)" }}>
                  <CheckRows entries={armPreflight ? armPreflightCount.entries : armCapabilityCount.entries} />
                </Box>
              ) : null}
            </Box>
          ) : null}

          <Box sx={{ p: 1.35, borderRadius: 2.5, bgcolor: "rgba(15,23,42,.28)", border: "1px solid rgba(148,163,184,.14)" }}>
            <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" gap={1.1} alignItems={{ sm: "center" }}>
              <Box sx={{ minWidth: 0 }}>
                <Stack direction="row" spacing={0.7} alignItems="center" useFlexGap flexWrap="wrap">
                  <Typography fontWeight={950}>AUTO</Typography>
                  <Chip label={autoStatusLabel} color={isAutoActive || autoStatus.data?.approved ? "success" : "warning"} size="small" />
                  {showAutoActivationDiagnostics ? (
                    <Chip label={`${autoCount.passed}/${autoCount.total} đạt`} size="small" variant="outlined" />
                  ) : null}
                </Stack>
                <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.45 }}>
                  Lý do: {autoReason}
                </Typography>
                {showAutoActivationDiagnostics && autoBlockedBy.length ? (
                  <Typography variant="caption" color="warning.main" sx={{ display: "block", mt: 0.3 }}>
                    Đang khóa bởi: {autoBlockedBy.map((key) => CHECK_LABELS[key] ?? key).join(" · ")}
                  </Typography>
                ) : null}
              </Box>
              <Stack direction="row" spacing={0.7} useFlexGap flexWrap="wrap">
                {showAutoActivationDiagnostics ? (
                  <Button size="small" variant="text" onClick={() => setShowAutoChecks((value) => !value)} sx={{ fontWeight: 900 }}>
                    {showAutoChecks ? "Ẩn chi tiết tự động" : "Chi tiết tự động"}
                  </Button>
                ) : null}
                <Button
                  size="small"
                  variant="contained"
                  color="primary"
                  disabled={!canAttemptAuto}
                  onClick={() => autoMutation.mutate()}
                  sx={{ fontWeight: 950, minWidth: 150 }}
                >
                  {isAutoActive
                    ? "Tự động đang bật"
                    : autoMutation.isPending
                      ? "Đang kiểm tra..."
                      : accountMode === "LIVE"
                        ? "Bật tự động Live"
                        : "Bật tự động Demo"}
                </Button>
              </Stack>
            </Stack>

            {showAutoActivationDiagnostics && showAutoChecks ? (
              <Box mt={1.1} pt={1.1} sx={{ borderTop: "1px solid rgba(148,163,184,.14)" }}>
                <CheckRows entries={autoCount.entries} />
              </Box>
            ) : null}
          </Box>

          {accountMode === "LIVE" && capability.isError ? (
            <Alert severity="error">Không đọc được LIVE ARM capability: {capability.error instanceof Error ? capability.error.message : "UNKNOWN"}</Alert>
          ) : null}
          {autoStatus.isError ? (
            <Alert severity="error">Không đọc được AUTO status: {autoStatus.error instanceof Error ? autoStatus.error.message : "UNKNOWN"}</Alert>
          ) : null}
          {accountMode === "LIVE" && capability.data && !capability.data.taskInstalled ? (
            <Alert severity="warning">Elevated LIVE ARM task chưa được đăng ký. Cần cài một lần bằng PowerShell Administrator.</Alert>
          ) : null}
          {accountMode === "LIVE" && armPreflightMutation.error ? (
            <Alert severity="error">{armPreflightMutation.error instanceof Error ? armPreflightMutation.error.message : "Không kiểm tra được điều kiện ARM LIVE."}</Alert>
          ) : null}
          {accountMode === "LIVE" && armMutation.error ? (
            <Alert severity="error">{armMutation.error instanceof Error ? armMutation.error.message : "ARM/DISARM bị từ chối."}</Alert>
          ) : null}
          {accountMode === "LIVE" && armStatus.data ? (
            <Alert severity={armStatus.data.status === "PASS" ? "success" : armStatus.data.status === "FAIL" ? "error" : "info"}>
              {armStatus.data.action} · {armStatus.data.status} · {armStatus.data.phase} · {armStatus.data.message} · ARM {armStatus.data.finalArmStatus}
            </Alert>
          ) : null}
          {autoMutation.isSuccess && isAutoActive ? (
            <Alert severity="success">AUTO đã bật qua guarded backend · source {autoMutation.data.state.updatedBy}.</Alert>
          ) : null}
          {autoMutation.error ? (
            <Alert severity="error">{autoMutation.error instanceof Error ? autoMutation.error.message : "AUTO bị từ chối."}</Alert>
          ) : null}
        </Stack>
      </CardContent>
    </Card>
  );
}
