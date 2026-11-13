import { useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getMt5Telemetry } from "../api";
import {
  executePhase7CAccountSwitch,
  getPhase7CAccountSwitchCapability,
  getPhase7CAccountSwitchStatus,
  getPhase7CSameModeAccountChangeReadiness,
  preflightPhase7CAccountSwitch,
} from "../phase7c-account-switch-api";
import {
  captureMt5AccountIdentity,
  getSameModeMt5AccountVerificationState,
  hasMt5AccountIdentityChanged,
  isSameModeMt5AccountVerified,
  maskMt5AccountLogin,
  SAME_MODE_ACCOUNT_CHANGE_POLICY,
  type Mt5AccountIdentity,
} from "../phase7c-account-switch";
import type {
  Phase7CAccountMode,
  Phase7CAccountSwitchPreflight,
} from "../phase7c-account-switch-types";
import { requestLocalControlJson } from "../local-control-request";

async function setPause() {
  return requestLocalControlJson<unknown>("/api/v1/phase7c/bot-mode", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "PAUSE", source: "web-account-switch-explicit-pause" }),
  });
}

const CHECK_LABELS: Record<string, string> = {
  taskInstalled: "Elevated switch task đã đăng ký",
  accountStateValid: "Account state hợp lệ",
  notAlreadyTarget: "Target khác account hiện tại",
  botPaused: "Bot đang PAUSE",
  runtimeReady: "Runtime/Telegram đang READY",
  bridgeMatchesSelectedAccount: "Bridge khớp loại account đang chọn",
  zeroXauusdPositions: "XAUUSD positions = 0",
  noTrendManagedTicket: "Trend không quản lý ticket",
  noSidewayManagedTicket: "Sideway không quản lý ticket",
  noTrendPendingPullback: "Trend không có pending pullback",
  noSidewayPendingEntry: "Sideway không có pending entry",
  noExecutionLock: "Không có execution lock",
  demoToLiveArmSafe: "Trạng thái chuyển LIVE an toàn",
  liveDisarmed: "Quyền giao dịch LIVE đã tắt trước khi đổi login",
  noSwitchRunning: "Không có account switch khác đang chạy",
};

function CheckRows({ checks }: { checks: Record<string, boolean> }) {
  return (
    <Stack spacing={0.8}>
      {Object.entries(checks).map(([key, passed]) => (
        <Stack key={key} direction="row" justifyContent="space-between" gap={2}>
          <Typography variant="body2" color="text.secondary">{CHECK_LABELS[key] ?? key}</Typography>
          <Typography variant="body2" fontWeight={900} color={passed ? "success.main" : "error.main"}>
            {passed ? "PASS" : "BLOCK"}
          </Typography>
        </Stack>
      ))}
    </Stack>
  );
}

function identityLabel(identity: Mt5AccountIdentity | null | undefined) {
  if (!identity) return "—";
  const mode = identity.accountMode ?? "?";
  const server = identity.server ?? "server ?";
  return `${mode} · ${maskMt5AccountLogin(identity.accountLogin)} · ${server}`;
}

export function Phase7CAccountSwitchCard() {
  const queryClient = useQueryClient();
  const [preflight, setPreflight] = useState<Phase7CAccountSwitchPreflight | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [sameModeBaseline, setSameModeBaseline] = useState<Mt5AccountIdentity | null>(null);
  const [sameModeDetailsOpen, setSameModeDetailsOpen] = useState(false);

  const capabilityQuery = useQuery({
    queryKey: ["phase7c-account-switch-capability"],
    queryFn: getPhase7CAccountSwitchCapability,
    refetchInterval: requestId ? false : 3_000,
    retry: false,
  });

  const sameModeReadinessQuery = useQuery({
    queryKey: ["phase7c-same-mode-account-change-readiness"],
    queryFn: getPhase7CSameModeAccountChangeReadiness,
    refetchInterval: 2_000,
    retry: false,
  });

  const telemetryQuery = useQuery({
    queryKey: ["phase7c-account-switch-mt5-telemetry"],
    queryFn: () => getMt5Telemetry("XAUUSD"),
    refetchInterval: 2_000,
    retry: false,
  });

  const currentMode = capabilityQuery.data?.currentAccountMode ?? "DEMO";
  const targetMode: Phase7CAccountMode = currentMode === "LIVE" ? "DEMO" : "LIVE";
  const requiredConfirmation = targetMode === "LIVE" ? "SWITCH_TO_LIVE" : "SWITCH_TO_DEMO";

  const pauseMutation = useMutation({
    mutationFn: setPause,
    onSuccess: async () => {
      setPreflight(null);
      setConfirmation("");
      await queryClient.invalidateQueries();
    },
  });

  const preflightMutation = useMutation({
    mutationFn: () => preflightPhase7CAccountSwitch(targetMode),
    onSuccess: (result) => {
      setPreflight(result);
      setConfirmation("");
    },
  });

  const executeMutation = useMutation({
    mutationFn: () => {
      if (!preflight?.preflightToken) throw new Error("Chưa có preflight token hợp lệ.");
      return executePhase7CAccountSwitch({
        targetMode,
        preflightToken: preflight.preflightToken,
        confirmation,
      });
    },
    onSuccess: (result) => setRequestId(result.requestId),
  });

  const statusQuery = useQuery({
    queryKey: ["phase7c-account-switch-status", requestId],
    queryFn: () => getPhase7CAccountSwitchStatus(requestId ?? ""),
    enabled: Boolean(requestId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "PASS" || status === "FAIL" ? false : 2_000;
    },
    retry: false,
  });

  const status = statusQuery.data;
  const switchRunning = Boolean(requestId && (!status || status.status === "RUNNING"));
  const switchDone = status?.status === "PASS" || status?.status === "FAIL";
  const canExecute = Boolean(
    preflight?.approved &&
      preflight.preflightToken &&
      confirmation === requiredConfirmation &&
      !switchRunning,
  );

  const checkRows = useMemo(() => Object.entries(preflight?.checks ?? {}), [preflight]);
  const readiness = sameModeReadinessQuery.data;
  const firstBlockedReadiness = useMemo(
    () => Object.entries(readiness?.checks ?? {}).find(([, passed]) => passed === false) ?? null,
    [readiness],
  );
  const readinessReason = firstBlockedReadiness
    ? CHECK_LABELS[firstBlockedReadiness[0]] ?? firstBlockedReadiness[0]
    : readiness?.approved
      ? "Tất cả điều kiện đã đạt"
      : "Đang chờ dữ liệu readiness";
  const currentIdentity = captureMt5AccountIdentity(telemetryQuery.data);
  const sameModeIdentityChanged = hasMt5AccountIdentityChanged(sameModeBaseline, currentIdentity);
  const sameModeVerificationState = getSameModeMt5AccountVerificationState({
    baseline: sameModeBaseline,
    telemetry: telemetryQuery.data,
    readiness,
  });
  const sameModeVerified = isSameModeMt5AccountVerified({
    baseline: sameModeBaseline,
    telemetry: telemetryQuery.data,
    readiness,
  });
  const canonicalProfileUnverified =
    sameModeVerificationState === "IDENTITY_CHANGED_BUT_CANONICAL_PROFILE_UNVERIFIED";
  const canPrepareSameMode = Boolean(
    readiness?.approved &&
      currentIdentity.accountLogin &&
      currentIdentity.accountMode === currentMode &&
      !sameModeBaseline &&
      !switchRunning,
  );

  const resetAfterDone = async () => {
    setRequestId(null);
    setPreflight(null);
    setConfirmation("");
    await queryClient.invalidateQueries();
  };

  const startSameModeChange = () => {
    if (!canPrepareSameMode) return;
    setSameModeBaseline(captureMt5AccountIdentity(telemetryQuery.data));
  };

  return (
    <Card variant="outlined" sx={{ borderRadius: 4, borderColor: "warning.main" }}>
      <CardContent sx={{ p: { xs: 2, md: 2.5 } }}>
        <Stack direction={{ xs: "column", lg: "row" }} justifyContent="space-between" gap={1.5}>
          <Box>
            <Typography variant="overline" color="warning.main" fontWeight={950}>ĐỔI TÀI KHOẢN MT5</Typography>
            <Typography variant="h5" fontWeight={950}>Guarded account switch · không lưu thông tin đăng nhập</Typography>
            <Typography variant="body2" color="text.secondary" mt={0.6}>
              DEMO ↔ LIVE dùng guarded task. Đổi login cùng loại thực hiện trực tiếp trong MT5; Web chỉ xác minh readiness và identity. Account switch không cấp quyền AUTO và không gửi order.
            </Typography>
          </Box>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="flex-start">
            <Chip label={`ACCOUNT ${currentMode}`} color={currentMode === "LIVE" ? "warning" : "success"} sx={{ fontWeight: 950 }} />
            <Chip label={`BOT ${capabilityQuery.data?.currentBotMode ?? "—"}`} variant="outlined" sx={{ fontWeight: 950 }} />
            <Chip label={`LOGIN ${maskMt5AccountLogin(currentIdentity.accountLogin)}`} variant="outlined" sx={{ fontWeight: 950 }} />
          </Stack>
        </Stack>

        <Divider sx={{ my: 2 }} />

        {capabilityQuery.isError && (
          <Alert severity="error" sx={{ mb: 1.5 }}>
            Không đọc được account-switch capability: {capabilityQuery.error instanceof Error ? capabilityQuery.error.message : "lỗi không xác định"}
          </Alert>
        )}
        {sameModeReadinessQuery.isError && (
          <Alert severity="error" sx={{ mb: 1.5 }}>
            Không đọc được readiness đổi login cùng loại: {sameModeReadinessQuery.error instanceof Error ? sameModeReadinessQuery.error.message : "lỗi không xác định"}
          </Alert>
        )}
        {capabilityQuery.data && !capabilityQuery.data.taskInstalled && (
          <Alert severity="warning" sx={{ mb: 1.5 }}>
            Elevated task chuyển DEMO/LIVE chưa được đăng ký. Chạy một lần bằng PowerShell Administrator: <b>scripts/register-phase7c-account-switch-task-local.ps1 -WorkDir .runtime</b>. Web không fallback sang đường kém an toàn hơn.
          </Alert>
        )}
        {capabilityQuery.data?.currentBotMode !== "PAUSE" && (
          <Alert severity="warning" sx={{ mb: 1.5 }}>
            Mọi loại đổi tài khoản đều bị khóa vì bot đang <b>{capabilityQuery.data?.currentBotMode}</b>. Hãy đưa bot về PAUSE trước.
          </Alert>
        )}
        {pauseMutation.isError && <Alert severity="error" sx={{ mb: 1.5 }}>{pauseMutation.error instanceof Error ? pauseMutation.error.message : "Không chuyển được PAUSE."}</Alert>}
        {preflightMutation.isError && <Alert severity="error" sx={{ mb: 1.5 }}>{preflightMutation.error instanceof Error ? preflightMutation.error.message : "Preflight thất bại."}</Alert>}
        {executeMutation.isError && <Alert severity="error" sx={{ mb: 1.5 }}>{executeMutation.error instanceof Error ? executeMutation.error.message : "Switch bị từ chối."}</Alert>}

        <Stack direction={{ xs: "column", md: "row" }} spacing={1.5}>
          <Button
            variant="outlined"
            color="warning"
            disabled={pauseMutation.isPending || switchRunning || capabilityQuery.data?.currentBotMode === "PAUSE"}
            onClick={() => {
              if (window.confirm("Xác nhận chuyển bot về PAUSE? Thao tác này chưa đổi account.")) pauseMutation.mutate();
            }}
            sx={{ fontWeight: 950 }}
          >
            {pauseMutation.isPending ? "Đang PAUSE..." : "Đưa Bot về PAUSE"}
          </Button>
        </Stack>

        <Box mt={2} sx={{ p: 1.5, borderRadius: 3, border: "1px solid", borderColor: "divider" }}>
          <Typography variant="overline" color="primary" fontWeight={950}>A. CHUYỂN DEMO ↔ LIVE</Typography>
          <Stack direction={{ xs: "column", md: "row" }} spacing={1.5} mt={0.8}>
            <Button
              variant="contained"
              disabled={preflightMutation.isPending || switchRunning || !capabilityQuery.data?.taskInstalled || capabilityQuery.data?.currentBotMode !== "PAUSE"}
              onClick={() => preflightMutation.mutate()}
              sx={{ fontWeight: 950 }}
            >
              {preflightMutation.isPending ? "Đang kiểm tra..." : `1. Kiểm tra điều kiện → ${targetMode}`}
            </Button>
          </Stack>

          {preflight && (
            <Box mt={1.5}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1} mb={1.2}>
                <Typography fontWeight={950}>Kết quả preflight</Typography>
                <Chip label={preflight.approved ? "PASS" : "BLOCKED"} color={preflight.approved ? "success" : "error"} size="small" sx={{ fontWeight: 950 }} />
              </Stack>
              <Stack spacing={0.8}>
                {checkRows.map(([key, passed]) => (
                  <Stack key={key} direction="row" justifyContent="space-between" gap={2}>
                    <Typography variant="body2" color="text.secondary">{CHECK_LABELS[key] ?? key}</Typography>
                    <Typography variant="body2" fontWeight={900} color={passed ? "success.main" : "error.main"}>{passed ? "PASS" : "BLOCK"}</Typography>
                  </Stack>
                ))}
              </Stack>

              {preflight.approved && (
                <Stack spacing={1.5} mt={1.5}>
                  <Typography variant="body2">
                    Nhập chính xác <b>{requiredConfirmation}</b>. Token preflight ngắn hạn và runtime được kiểm tra lại ngay trước switch.
                  </Typography>
                  <TextField
                    label="Xác nhận account switch"
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value.toUpperCase())}
                    placeholder={requiredConfirmation}
                    disabled={switchRunning}
                    fullWidth
                  />
                  <Button
                    variant="contained"
                    color={targetMode === "LIVE" ? "warning" : "primary"}
                    disabled={!canExecute || executeMutation.isPending}
                    onClick={() => {
                      const message = `Xác nhận guarded switch sang ${targetMode}? Kết quả luôn PAUSE; quyền LIVE/AUTO không tự được bật lại.`;
                      if (window.confirm(message)) executeMutation.mutate();
                    }}
                    sx={{ fontWeight: 950 }}
                  >
                    {executeMutation.isPending ? "Đang gửi yêu cầu..." : `2. Xác nhận chuyển sang ${targetMode}`}
                  </Button>
                </Stack>
              )}
            </Box>
          )}

          {requestId && (
            <Box mt={1.5}>
              <Alert severity={status?.status === "PASS" ? "success" : status?.status === "FAIL" ? "error" : "info"}>
                <Typography fontWeight={950}>Account switch: {status?.status ?? "RUNNING"} · {status?.phase ?? "QUEUED"}</Typography>
                <Typography variant="body2" mt={0.5}>{status?.message ?? "Elevated task đang xử lý. Không đóng API/MT5 trong lúc switch."}</Typography>
                {status?.status === "PASS" && (
                  <Typography variant="body2" mt={0.5}>Final: {status.finalAccountMode} · Bot {status.finalBotMode}. Quyền giao dịch phải được cấp lại riêng nếu cần.</Typography>
                )}
              </Alert>
              {switchDone && (
                <Button variant="outlined" onClick={resetAfterDone} sx={{ mt: 1.2, fontWeight: 900 }}>Nạp lại trạng thái</Button>
              )}
            </Box>
          )}
        </Box>

        <Box mt={1.5} sx={{ p: 1.5, borderRadius: 3, border: "1px solid", borderColor: readiness?.approved ? "success.main" : "divider" }}>
          <Typography variant="overline" color="secondary" fontWeight={950}>B. ĐỔI LOGIN CÙNG LOẠI · {currentMode} → {currentMode}</Typography>
          <Typography variant="body2" color="text.secondary" mt={0.35}>
            Đổi login {currentMode} cùng loại thực hiện trực tiếp trong MT5. Web chỉ chuẩn bị và xác minh account identity; không nhận credential.
            {currentMode === "LIVE" && " LIVE → LIVE cần rebind/xác minh canonical profile riêng trước khi ARM/AUTO lại."}
          </Typography>

          {readiness && (
            <Box mt={1.2}>
              <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ xs: "flex-start", sm: "center" }} gap={1}>
                <Box>
                  <Typography fontWeight={900}>Readiness cùng loại</Typography>
                  <Typography variant="body2" color="text.secondary">
                    Lý do: <b>{readinessReason}</b>
                  </Typography>
                </Box>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip
                    label={readiness.approved ? "SẴN SÀNG" : "BỊ CHẶN"}
                    color={readiness.approved ? "success" : "error"}
                    size="small"
                    sx={{ fontWeight: 900 }}
                  />
                  <Button
                    variant="outlined"
                    size="small"
                    onClick={() => setSameModeDetailsOpen((open) => !open)}
                    sx={{ fontWeight: 900 }}
                  >
                    {sameModeDetailsOpen ? "Ẩn chi tiết" : "Xem chi tiết"}
                  </Button>
                </Stack>
              </Stack>

              {sameModeDetailsOpen && (
                <Box mt={1.2} pt={1.2} sx={{ borderTop: "1px solid", borderColor: "divider" }}>
                  <CheckRows checks={readiness.checks} />
                </Box>
              )}
            </Box>
          )}

          {currentMode === "LIVE" && readiness?.checks.liveDisarmed === false && (
            <Alert severity="warning" sx={{ mt: 1.2 }}>
              LIVE → LIVE yêu cầu PAUSE + DISARMED + flat trước khi đổi login.
            </Alert>
          )}

          {!sameModeBaseline ? (
            <Button
              variant="contained"
              color="secondary"
              disabled={!canPrepareSameMode}
              onClick={startSameModeChange}
              sx={{ mt: 1.4, fontWeight: 950 }}
            >
              Chuẩn bị đổi login MT5
            </Button>
          ) : (
            <Stack spacing={1.3} mt={1.4}>
              <Alert severity={sameModeVerified ? "success" : canonicalProfileUnverified ? "error" : sameModeIdentityChanged ? "warning" : "info"}>
                <Typography fontWeight={950}>
                  {sameModeVerified
                    ? "TÀI KHOẢN MỚI ĐÃ XÁC MINH"
                    : canonicalProfileUnverified
                      ? "LOGIN LIVE MỚI ĐÃ PHÁT HIỆN · CANONICAL PROFILE CHƯA XÁC MINH"
                      : "ĐANG CHỜ BẠN ĐĂNG NHẬP TÀI KHOẢN MỚI TRONG MT5"}
                </Typography>
                <Typography variant="body2" mt={0.5}>
                  Cũ: {identityLabel(sameModeBaseline)}
                </Typography>
                <Typography variant="body2">
                  Hiện tại: {identityLabel(currentIdentity)}
                </Typography>
                <Typography variant="body2" mt={0.5}>
                  Login changed: <b>{sameModeIdentityChanged ? "YES" : "NO"}</b> · readiness: <b>{readiness?.approved ? "PASS" : "BLOCKED"}</b> · verification: <b>{sameModeVerificationState}</b>
                </Typography>
              </Alert>

              {canonicalProfileUnverified && (
                <Alert severity="error">
                  IDENTITY_CHANGED_BUT_CANONICAL_PROFILE_UNVERIFIED: MT5 đã thấy login LIVE mới, nhưng Web không có canonical writer để rebind MT5_LOGIN / MT5_ALLOWED_LOGINS / LIVE risk profile. Không ARM và không bật AUTO lại từ trạng thái này. Cần một workflow rebind canonical riêng rồi mới chạy production acceptance cho account mới.
                </Alert>
              )}

              {!sameModeVerified && !canonicalProfileUnverified && (
                <Typography variant="body2" color="text.secondary">
                  Mở MT5 và đăng nhập tài khoản {currentMode} khác. Giữ bot PAUSE; nếu là LIVE thì quyền giao dịch phải tiếp tục tắt. Web sẽ tự đọc lại sau mỗi 2 giây.
                </Typography>
              )}

              {sameModeVerified && (
                <Alert severity="success">
                  Account identity đã đổi và các cổng an toàn vẫn PASS. Bot vẫn PAUSE; Web không tự cấp quyền LIVE và không tự bật AUTO. Nếu muốn chạy lại, thực hiện các bước cấp quyền/activation riêng.
                </Alert>
              )}

              <Button
                variant="outlined"
                onClick={() => setSameModeBaseline(null)}
                sx={{ alignSelf: "flex-start", fontWeight: 900 }}
              >
                {sameModeVerified ? "Hoàn tất / đóng phiên đổi login" : "Hủy phiên theo dõi"}
              </Button>
            </Stack>
          )}
        </Box>

        <Typography variant="caption" color="text.secondary" display="block" mt={1.5} sx={{ lineHeight: 1.5 }}>
          Credential input: {SAME_MODE_ACCOUNT_CHANGE_POLICY.credentialInput} · không gửi order · không đổi lot/risk · không tự ARM/AUTO.
        </Typography>
      </CardContent>
    </Card>
  );
}
