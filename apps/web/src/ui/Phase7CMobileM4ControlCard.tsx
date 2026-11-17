import { useNow } from "../use-now";
import { useMemo, useState } from "react";
import { Alert, Box, Button, Card, CardContent, Chip, Stack, Typography } from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  executeMobileArm,
  executeMobileMode,
  getMobileArmStatus,
  getMobileM4State,
  preflightMobileArm,
  type MobileM4ArmPreflight,
  type MobileM4Mode,
} from "../mobile-m4-control";

const MODES: MobileM4Mode[] = ["AUTO", "SEMI", "TREND", "SIDEWAY", "PAUSE"];

function CheckRows({ checks }: { checks: Record<string, boolean> }) {
  const entries = Object.entries(checks);
  if (!entries.length) return null;
  return (
    <Stack spacing={0.45}>
      {entries.map(([key, passed]) => (
        <Stack key={key} direction="row" justifyContent="space-between" gap={1.5}>
          <Typography variant="caption" color="text.secondary">{key}</Typography>
          <Typography variant="caption" fontWeight={900} color={passed ? "success.main" : "error.main"}>
            {passed ? "Đạt" : "BLOCK"}
          </Typography>
        </Stack>
      ))}
    </Stack>
  );
}

export function Phase7CMobileM4ControlCard() {
  const now = useNow();
  const queryClient = useQueryClient();
  const [preflight, setPreflight] = useState<MobileM4ArmPreflight | null>(null);
  const [activeTransactionId, setActiveTransactionId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const state = useQuery({
    queryKey: ["mobile-m4-state"],
    queryFn: () => getMobileM4State(),
    refetchInterval: 3_000,
    retry: false,
  });

  const status = useQuery({
    queryKey: ["mobile-m4-status", activeTransactionId],
    queryFn: () => getMobileArmStatus(activeTransactionId ?? ""),
    enabled: Boolean(activeTransactionId),
    refetchInterval: (query) => {
      const value = query.state.data;
      return value?.status === "PASS" || value?.status === "FAIL" || value?.status === "AMBIGUOUS"
        ? false
        : 1_500;
    },
    retry: false,
  });

  const modeMutation = useMutation({
    mutationFn: async (mode: MobileM4Mode) => {
      const current = state.data?.mode ?? "UNKNOWN";
      if (!window.confirm(`Xác nhận đổi MODE production: ${current} → ${mode}?`)) {
        throw new Error("Đã hủy thao tác.");
      }
      return executeMobileMode(mode);
    },
    onSuccess: async (result) => {
      setMessage(result.auditDegraded ? "Đổi mode thành công; audit gateway đang degraded." : "Đổi mode thành công.");
      await queryClient.invalidateQueries({ queryKey: ["mobile-m4-state"] });
    },
  });

  const preflightMutation = useMutation({
    mutationFn: () => preflightMobileArm("ARM_LIVE"),
    onSuccess: (result) => {
      setPreflight(result);
      setMessage(result.approved ? "ARM preflight PASS. Hãy xác nhận ARM trong thời gian token còn hiệu lực." : "ARM bị canonical gate khóa.");
    },
  });

  const executeArmMutation = useMutation({
    mutationFn: async () => {
      if (!preflight?.approved || !preflight.transactionId) throw new Error("ARM preflight chưa PASS.");
      if (preflight.expiresAt != null && Date.now() >= preflight.expiresAt) throw new Error("ARM preflight đã hết hạn. Hãy kiểm tra lại.");
      const confirmed = window.confirm(
        "Xác nhận ARM LIVE? Bot phải đang PAUSE; thao tác này không bật AUTO và không gửi order.",
      );
      if (!confirmed) throw new Error("Đã hủy thao tác.");
      return executeMobileArm("ARM_LIVE", preflight.transactionId);
    },
    onSuccess: (result) => {
      setPreflight(null);
      if (result.outcome === "RUNNING") setActiveTransactionId(result.transactionId);
      setMessage(result.outcome === "RUNNING" ? "ARM đã được canonical control tiếp nhận; đang chờ PASS." : result.message ?? result.outcome);
    },
  });

  const disarmMutation = useMutation({
    mutationFn: async () => {
      if (!window.confirm("Xác nhận DISARM LIVE? Thao tác này thu hồi quyền mở lệnh mới và không đóng vị thế đang có.")) {
        throw new Error("Đã hủy thao tác.");
      }
      const pf = await preflightMobileArm("DISARM_LIVE");
      if (!pf.approved || !pf.transactionId) {
        throw new Error(`DISARM bị khóa: ${(pf.blockedBy ?? []).join(", ") || "UNKNOWN"}`);
      }
      return executeMobileArm("DISARM_LIVE", pf.transactionId);
    },
    onSuccess: (result) => {
      if (result.outcome === "RUNNING") setActiveTransactionId(result.transactionId);
      setMessage(result.outcome === "RUNNING" ? "DISARM đang chờ canonical PASS." : result.message ?? result.outcome);
    },
  });

  const armReady = Boolean(
    preflight?.approved &&
    preflight.transactionId &&
    (preflight.expiresAt == null || now < preflight.expiresAt),
  );

  const finalStatus = status.data;
  const finalSuccess = finalStatus?.status === "PASS" && (
    (finalStatus.action === "ARM_LIVE" && finalStatus.finalArmStatus === "ARMED") ||
    (finalStatus.action === "DISARM_LIVE" && finalStatus.finalArmStatus === "DISARMED")
  );

  const autoBlockedReason = useMemo(() => {
    const blocked = state.data?.auto.blockedBy ?? [];
    return blocked.length ? blocked.join(", ") : state.data?.auto.approved ? "READY" : "Đang đọc canonical gate";
  }, [state.data]);

  const busy = modeMutation.isPending || preflightMutation.isPending || executeArmMutation.isPending || disarmMutation.isPending;

  return (
    <Card variant="outlined" sx={{ borderRadius: 3, borderColor: "rgba(249,185,73,.35)" }}>
      <CardContent sx={{ p: { xs: 1.5, sm: 1.8 }, "&:last-child": { pb: { xs: 1.5, sm: 1.8 } } }}>
        <Stack spacing={1.35}>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={1}>
            <Box>
              <Typography variant="overline" color="warning.main" fontWeight={950}>M4 SECURE REMOTE CONTROL</Typography>
              <Typography variant="h6" fontWeight={950}>Điều khiển bot có giới hạn</Typography>
            </Box>
            <Stack direction="row" spacing={0.6} useFlexGap flexWrap="wrap" justifyContent="flex-end">
              <Chip label={`MODE ${state.data?.mode ?? "—"}`} size="small" variant="outlined" />
              <Chip
                label={`LIVE ${state.data?.arm.liveArmStatus ?? "—"}`}
                size="small"
                color={state.data?.arm.liveExecutionArmed ? "success" : "warning"}
                variant="outlined"
              />
            </Stack>
          </Stack>

          {state.isError ? <Alert severity="error">Không đọc được M4 state: {state.error instanceof Error ? state.error.message : "UNKNOWN"}</Alert> : null}

          <Box>
            <Typography variant="caption" color="text.secondary">AUTO gate: {autoBlockedReason}</Typography>
            <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" mt={0.8}>
              {MODES.map((mode) => (
                <Button
                  key={mode}
                  size="small"
                  variant={state.data?.mode === mode ? "contained" : "outlined"}
                  color={mode === "PAUSE" ? "warning" : mode === "AUTO" ? "success" : "primary"}
                  disabled={busy || state.data?.mode === mode}
                  onClick={() => modeMutation.mutate(mode)}
                  sx={{ fontWeight: 950 }}
                >
                  {mode}
                </Button>
              ))}
            </Stack>
          </Box>

          <Box sx={{ p: 1.2, border: "1px solid rgba(148,163,184,.14)", borderRadius: 2.5 }}>
            <Stack spacing={1}>
              <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
                {!state.data?.arm.liveExecutionArmed ? (
                  <>
                    <Button
                      size="small"
                      variant="outlined"
                      disabled={busy}
                      onClick={() => preflightMutation.mutate()}
                      sx={{ fontWeight: 900 }}
                    >
                      {preflightMutation.isPending ? "ĐANG KIỂM TRA..." : "KIỂM TRA ARM LIVE"}
                    </Button>
                    <Button
                      size="small"
                      variant="contained"
                      color="success"
                      disabled={busy || !armReady}
                      onClick={() => executeArmMutation.mutate()}
                      sx={{ fontWeight: 950 }}
                    >
                      ARM LIVE
                    </Button>
                  </>
                ) : (
                  <Button
                    size="small"
                    variant="outlined"
                    color="error"
                    disabled={busy}
                    onClick={() => disarmMutation.mutate()}
                    sx={{ fontWeight: 950 }}
                  >
                    DISARM LIVE
                  </Button>
                )}
              </Stack>

              {preflight ? (
                <Box>
                  <Typography variant="caption" fontWeight={900} color={preflight.approved ? "success.main" : "warning.main"}>
                    ARM PREFLIGHT: {preflight.approved ? "PASS" : "BLOCKED"}
                  </Typography>
                  {(preflight.blockedBy ?? []).length ? (
                    <Typography variant="caption" color="text.secondary" display="block">
                      Blocked: {(preflight.blockedBy ?? []).join(", ")}
                    </Typography>
                  ) : null}
                  <Box mt={0.6}><CheckRows checks={preflight.checks ?? {}} /></Box>
                </Box>
              ) : null}

              {finalStatus ? (
                <Alert severity={finalSuccess ? "success" : finalStatus.status === "FAIL" || finalStatus.status === "AMBIGUOUS" ? "error" : "info"}>
                  {finalStatus.action} · {finalStatus.status} · {finalStatus.finalArmStatus ?? "—"}
                  {finalStatus.message ? ` · ${finalStatus.message}` : ""}
                </Alert>
              ) : null}

              {message ? <Typography variant="caption" color="text.secondary">{message}</Typography> : null}
              {modeMutation.isError || preflightMutation.isError || executeArmMutation.isError || disarmMutation.isError ? (
                <Alert severity="error">
                  {(modeMutation.error ?? preflightMutation.error ?? executeArmMutation.error ?? disarmMutation.error) instanceof Error
                    ? String((modeMutation.error ?? preflightMutation.error ?? executeArmMutation.error ?? disarmMutation.error)?.message)
                    : "Thao tác M4 thất bại."}
                </Alert>
              ) : null}
            </Stack>
          </Box>

          <Typography variant="caption" color="text.secondary">
            M4-A chỉ cho MODE + ARM/DISARM qua Tailscale. Không có lifecycle, account switch, lot setting, order hoặc position control.
          </Typography>
        </Stack>
      </CardContent>
    </Card>
  );
}
