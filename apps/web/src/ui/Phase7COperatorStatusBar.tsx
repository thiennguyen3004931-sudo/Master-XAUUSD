import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, Chip, Stack, Typography } from "@mui/material";
import { getPhase7CLifecycle } from "../api";
import { getPhase7CSameModeAccountChangeReadiness } from "../phase7c-account-switch-api";
import { maskMt5AccountLogin } from "../phase7c-account-switch";
import { getPhase7CLiveArmControlCapability } from "../phase7c-execution-control";
import { getPhase7CRuntimeSourceAttestation } from "../phase7c-runtime-source-attestation-api";

export function Phase7COperatorStatusBar() {
  const lifecycle = useQuery({
    queryKey: ["phase7c-lifecycle"],
    queryFn: getPhase7CLifecycle,
    refetchInterval: 2_000,
    retry: false,
  });
  const account = useQuery({
    queryKey: ["phase7c-same-mode-account-change-readiness"],
    queryFn: getPhase7CSameModeAccountChangeReadiness,
    refetchInterval: 2_000,
    retry: false,
  });
  const capability = useQuery({
    queryKey: ["phase7c-live-arm-control-capability"],
    queryFn: getPhase7CLiveArmControlCapability,
    refetchInterval: 3_000,
    retry: false,
  });
  const runtimeSource = useQuery({
    queryKey: ["phase7c-runtime-source-attestation"],
    queryFn: getPhase7CRuntimeSourceAttestation,
    refetchInterval: 5_000,
    retry: false,
  });

  const accountMode = account.data?.currentMode ?? capability.data?.accountMode ?? "DEMO";
  const accountLogin = account.data?.accountLogin ?? null;
  const botMode = capability.data?.botMode ?? lifecycle.data?.mode.mode ?? "—";
  const armed = accountMode === "LIVE" && capability.data?.liveExecutionArmed === true;
  const positions = lifecycle.data?.bridge.openXauusdPositions ?? capability.data?.openXauusdPositions ?? 0;
  const sourceVerdict = runtimeSource.data?.overall ?? "UNKNOWN";
  const bridgeReady = lifecycle.data?.bridge.reachable === true;
  const runtimeReady = lifecycle.data?.ready === true;
  const server = account.data?.server ?? lifecycle.data?.bridge.server ?? null;

  return (
    <Card
      variant="outlined"
      sx={{
        borderRadius: 3,
        borderColor: sourceVerdict === "EXACT_MATCH" && runtimeReady ? "success.main" : "warning.main",
        bgcolor: "rgba(15,23,42,.34)",
      }}
    >
      <CardContent sx={{ py: 1.35, px: { xs: 1.5, md: 2 }, "&:last-child": { pb: 1.35 } }}>
        <Stack direction={{ xs: "column", lg: "row" }} spacing={1.2} justifyContent="space-between" alignItems={{ lg: "center" }}>
          <Stack direction="row" spacing={0.7} useFlexGap flexWrap="wrap" alignItems="center">
            <Typography variant="overline" color="text.secondary" fontWeight={950} sx={{ mr: 0.3 }}>
              OPERATOR STATUS
            </Typography>
            <Chip label={`ACCOUNT ${accountMode}`} color={accountMode === "LIVE" ? "warning" : "success"} size="small" sx={{ fontWeight: 950 }} />
            <Chip label={accountLogin ? maskMt5AccountLogin(accountLogin) : "LOGIN —"} size="small" variant="outlined" />
            <Chip label={bridgeReady ? "MT5 ✓" : "MT5 OFFLINE"} color={bridgeReady ? "success" : "warning"} size="small" variant="outlined" />
            <Chip label={runtimeReady ? "BOT READY" : "BOT NOT READY"} color={runtimeReady ? "success" : "warning"} size="small" variant="outlined" />
            <Chip label={`BOT ${botMode}`} color={botMode === "AUTO" ? "success" : "default"} size="small" variant="outlined" sx={{ fontWeight: 900 }} />
            {accountMode === "LIVE" ? (
              <Chip label={armed ? "ARMED" : "DISARMED"} color={armed ? "success" : "error"} size="small" variant={armed ? "filled" : "outlined"} sx={{ fontWeight: 950 }} />
            ) : null}
            <Chip label={`POSITIONS ${positions}`} color={positions === 0 ? "default" : "warning"} size="small" variant="outlined" />
            <Chip label={`SOURCE ${sourceVerdict}`} color={sourceVerdict === "EXACT_MATCH" ? "success" : "warning"} size="small" variant={sourceVerdict === "EXACT_MATCH" ? "filled" : "outlined"} sx={{ fontWeight: 900 }} />
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: { lg: "nowrap" } }}>
            {server ?? "MT5 server —"}
          </Typography>
        </Stack>
      </CardContent>
    </Card>
  );
}
