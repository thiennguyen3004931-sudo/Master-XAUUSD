import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  Stack,
  Typography,
} from "@mui/material";
import { getPhase7CRuntimeSourceAttestation } from "../phase7c-runtime-source-attestation-api";
import type {
  Phase7CRuntimeSourceComponentName,
  Phase7CRuntimeSourceVerdict,
} from "../phase7c-runtime-source-attestation-types";

const COMPONENTS: readonly Phase7CRuntimeSourceComponentName[] = [
  "api",
  "lifecycle-broker",
  "supervisor",
  "trend",
  "sideway",
  "telegram",
  "regime-notifier",
];

function verdictColor(verdict: Phase7CRuntimeSourceVerdict): "success" | "error" | "warning" | "default" {
  if (verdict === "EXACT_MATCH") return "success";
  if (verdict === "MISMATCH") return "error";
  if (verdict === "STALE") return "warning";
  return "warning";
}

function shortSha(value: string | null | undefined): string {
  if (!value) return "—";
  return value.length > 12 ? value.slice(0, 12) : value;
}

export function Phase7CRuntimeSourceAttestationCard() {
  const [showDetails, setShowDetails] = useState(false);
  const query = useQuery({
    queryKey: ["phase7c-runtime-source-attestation"],
    queryFn: getPhase7CRuntimeSourceAttestation,
    refetchInterval: 5000,
    retry: false,
  });

  const snapshot = query.data;
  const byComponent = new Map(snapshot?.components.map((item) => [item.component, item]) ?? []);

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1} justifyContent="space-between" alignItems={{ sm: "center" }}>
            <Box>
              <Typography variant="h6">Runtime Source Attestation</Typography>
              <Typography variant="body2" color="text.secondary">
                Đối chiếu source đã chấp nhận với các process Phase7C đang chạy. Chỉ đọc, không tự động thay đổi bot.
              </Typography>
            </Box>
            <Stack direction="row" spacing={1} alignItems="center">
              {snapshot ? (
                <Chip
                  label={snapshot.overall}
                  color={verdictColor(snapshot.overall)}
                  variant={snapshot.overall === "UNKNOWN" ? "outlined" : "filled"}
                />
              ) : null}
              <Button
                size="small"
                variant="text"
                aria-expanded={showDetails}
                onClick={() => setShowDetails((value) => !value)}
              >
                {showDetails ? "Ẩn chi tiết" : "Hiện chi tiết"}
              </Button>
            </Stack>
          </Stack>

          {query.isLoading ? (
            <Stack direction="row" spacing={1} alignItems="center">
              <CircularProgress size={18} />
              <Typography variant="body2">Đang đọc runtime source attestation…</Typography>
            </Stack>
          ) : null}

          {query.isError ? (
            <Alert severity="warning">Không đọc được runtime source attestation. Không có hành động tự động nào được thực hiện.</Alert>
          ) : null}

          {snapshot && snapshot.overall !== "EXACT_MATCH" ? (
            <Alert severity={snapshot.overall === "MISMATCH" ? "error" : "warning"}>
              READ-ONLY WARNING — NO AUTOMATIC ACTION TAKEN
            </Alert>
          ) : null}

          {snapshot && showDetails ? (
            <>
              <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">Accepted commit</Typography>
                  <Typography variant="body2" sx={{ fontFamily: "monospace" }}>
                    {snapshot.deployment?.sourceCommit ?? "UNKNOWN"}
                  </Typography>
                </Box>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">Deployment ID</Typography>
                  <Typography variant="body2" sx={{ fontFamily: "monospace" }}>
                    {snapshot.deployment?.deploymentId ?? "UNKNOWN"}
                  </Typography>
                </Box>
              </Stack>

              <Divider />

              <Stack spacing={1}>
                {COMPONENTS.map((component) => {
                  const item = byComponent.get(component);
                  const verdict = item?.verdict ?? "UNKNOWN";
                  return (
                    <Stack
                      key={component}
                      direction={{ xs: "column", sm: "row" }}
                      spacing={1}
                      justifyContent="space-between"
                      alignItems={{ sm: "center" }}
                      sx={{ py: 0.5 }}
                    >
                      <Box>
                        <Typography variant="body2" fontWeight={600}>{component}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          PID {item?.pid ?? "—"} · source {shortSha(item?.sourceCommit)}
                        </Typography>
                      </Box>
                      <Chip size="small" label={verdict} color={verdictColor(verdict)} variant={verdict === "UNKNOWN" ? "outlined" : "filled"} />
                    </Stack>
                  );
                })}
              </Stack>
            </>
          ) : null}
        </Stack>
      </CardContent>
    </Card>
  );
}
