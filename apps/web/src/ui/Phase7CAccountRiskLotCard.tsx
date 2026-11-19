import { useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  clean,
  fetchPhase7CWebStatus,
  pickText,
  raw,
  value,
} from "../phase7c-panel-status";
import { resolveConfiguredLotSettings } from "../phase7c-lot-settings";

type LotInput = {
  trendFixedLot: number;
  sidewayRiskPercent: number;
  sidewayMaxLot: number;
};

type FixedTpSnapshot = {
  trendFixedTpEnabled: boolean;
  trendFixedTpDistance: number;
  sidewayFixedTpEnabled: boolean;
  sidewayFixedTpDistance: number;
};

type LotSettingsMutationInput = LotInput & FixedTpSnapshot;

const LOT_SETTINGS_URL = "/api/v1/phase7c/lot-settings";
const CONTROL_BASE = "http://127.0.0.1:3711";
const MANAGED_LOT_STEP = 0.03;

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function clampLotInputs(input: LotInput): LotInput {
  return {
    trendFixedLot: Number(input.trendFixedLot.toFixed(2)),
    sidewayRiskPercent: Number(input.sidewayRiskPercent.toFixed(2)),
    sidewayMaxLot: Number(input.sidewayMaxLot.toFixed(2)),
  };
}

function isManagedLotIncrement(input: number) {
  if (!Number.isFinite(input)) return false;
  const units = input / MANAGED_LOT_STEP;
  return Math.abs(units - Math.round(units)) < 1e-8;
}

function validateLotInput(input: LotInput) {
  const errors: string[] = [];
  if (!Number.isFinite(input.trendFixedLot) || input.trendFixedLot < 0.03 || input.trendFixedLot > 1.2) {
    errors.push("Trend fixed lot phải trong khoảng 0.03–1.20.");
  } else if (!isManagedLotIncrement(input.trendFixedLot)) {
    errors.push("Trend fixed lot phải theo bước 0.03.");
  }
  if (!Number.isFinite(input.sidewayRiskPercent) || input.sidewayRiskPercent < 0.01 || input.sidewayRiskPercent > 1) {
    errors.push("Sideway risk percent phải trong khoảng 0.01–1.00%.");
  }
  if (!Number.isFinite(input.sidewayMaxLot) || input.sidewayMaxLot < 0.03 || input.sidewayMaxLot > 1.2) {
    errors.push("Sideway max lot phải trong khoảng 0.03–1.20.");
  } else if (!isManagedLotIncrement(input.sidewayMaxLot)) {
    errors.push("Sideway max lot phải theo bước 0.03.");
  }
  return errors;
}

function lotEquals(a: LotInput, b: LotInput) {
  return Math.abs(a.trendFixedLot - b.trendFixedLot) < 0.0001
    && Math.abs(a.sidewayRiskPercent - b.sidewayRiskPercent) < 0.0001
    && Math.abs(a.sidewayMaxLot - b.sidewayMaxLot) < 0.0001;
}

async function saveLotSettings(input: LotSettingsMutationInput) {
  const body = JSON.stringify({ ...input, source: "web-account-risk-v2" });
  const errors: string[] = [];

  for (const url of [LOT_SETTINGS_URL, `${CONTROL_BASE}${LOT_SETTINGS_URL}`]) {
    try {
      const response = await fetch(url, {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json", accept: "application/json" },
        body,
      });
      const text = await response.text();
      if (response.ok) return text ? JSON.parse(text) : {};
      errors.push(`HTTP ${response.status}: ${text.slice(0, 180)}`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Không kết nối được");
    }
  }

  throw new Error(errors.join(" | "));
}

function RiskRow({ label, valueText, strong = false }: { label: string; valueText: string; strong?: boolean }) {
  return (
    <Stack direction="row" justifyContent="space-between" gap={2} py={0.7}>
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Typography variant="body2" fontWeight={strong ? 950 : 850} textAlign="right">{valueText}</Typography>
    </Stack>
  );
}

export function Phase7CAccountRiskLotCard({
  editorOpen,
  onToggleEditor,
}: {
  editorOpen: boolean;
  onToggleEditor: () => void;
}) {
  const queryClient = useQueryClient();
  const [trendFixedLot, setTrendFixedLot] = useState("");
  const [sidewayRiskPercent, setSidewayRiskPercent] = useState("");
  const [sidewayMaxLot, setSidewayMaxLot] = useState("");

  const query = useQuery({
    queryKey: ["phase7c-web-status-account-risk-v6"],
    queryFn: fetchPhase7CWebStatus,
    refetchInterval: 3_000,
    retry: false,
    placeholderData: (previous) => previous,
  });

  const mutation = useMutation({
    mutationFn: saveLotSettings,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["phase7c-web-status-account-risk-v6"] });
    },
  });

  const data = query.data;
  const panel = data?.panel;
  const accountRisk = asRecord(data?.accountRisk);
  const configuration = asRecord(accountRisk.configuration);
  const lifecycle = asRecord(data?.lifecycle);
  const bridge = asRecord(lifecycle.bridge);
  const mode = asRecord(lifecycle.mode);
  const resolvedConfiguredLot = resolveConfiguredLotSettings(data?.lotSettings, configuration);
  const canonicalLotSettingsState = asRecord(asRecord(data?.lotSettings).state);

  const trendFixedTpDistance = Number(canonicalLotSettingsState.trendFixedTpDistance);
  const sidewayFixedTpDistance = Number(canonicalLotSettingsState.sidewayFixedTpDistance);
  const canonicalFixedTp: FixedTpSnapshot | null =
    typeof canonicalLotSettingsState.trendFixedTpEnabled === "boolean"
    && Number.isFinite(trendFixedTpDistance)
    && trendFixedTpDistance >= 0
    && (!canonicalLotSettingsState.trendFixedTpEnabled || trendFixedTpDistance > 0)
    && typeof canonicalLotSettingsState.sidewayFixedTpEnabled === "boolean"
    && Number.isFinite(sidewayFixedTpDistance)
    && sidewayFixedTpDistance >= 0
    && (!canonicalLotSettingsState.sidewayFixedTpEnabled || sidewayFixedTpDistance > 0)
      ? {
          trendFixedTpEnabled: canonicalLotSettingsState.trendFixedTpEnabled,
          trendFixedTpDistance,
          sidewayFixedTpEnabled: canonicalLotSettingsState.sidewayFixedTpEnabled,
          sidewayFixedTpDistance,
        }
      : null;

  const activeMode = clean(data?.ui?.mode, clean(mode.mode, value(panel, "activeMode", "—")));
  const openPositions = Number(pickText(bridge.openXauusdPositions, raw(panel, "positionCount"), "0"));
  const canSafelyApply = activeMode === "PAUSE" && openPositions === 0;
  const savedLot = resolvedConfiguredLot ? clampLotInputs(resolvedConfiguredLot) : null;

  const draftLot = clampLotInputs({
    trendFixedLot: Number(trendFixedLot),
    sidewayRiskPercent: Number(sidewayRiskPercent),
    sidewayMaxLot: Number(sidewayMaxLot),
  });
  const validationErrors = validateLotInput(draftLot);
  const hasChanges = savedLot !== null && validationErrors.length === 0 && !lotEquals(savedLot, draftLot);

  const lotSyncKey = JSON.stringify([savedLot?.trendFixedLot, savedLot?.sidewayRiskPercent, savedLot?.sidewayMaxLot]);
  const [syncedLotKey, setSyncedLotKey] = useState<string | null>(null);
  if (syncedLotKey !== lotSyncKey) {
    setSyncedLotKey(lotSyncKey);
    if (!savedLot) {
      setTrendFixedLot("");
      setSidewayRiskPercent("");
      setSidewayMaxLot("");
    } else {
      setTrendFixedLot(savedLot.trendFixedLot.toFixed(2));
      setSidewayRiskPercent(savedLot.sidewayRiskPercent.toFixed(2));
      setSidewayMaxLot(savedLot.sidewayMaxLot.toFixed(2));
    }
  }

  const onSubmit = () => {
    if (!savedLot || !canonicalFixedTp || !canSafelyApply || validationErrors.length > 0 || !hasChanges) return;
    const confirmed = window.confirm(
      `Xác nhận lưu cấu hình risk cho LỆNH MỚI?\n\nTrend fixed lot: ${savedLot.trendFixedLot.toFixed(2)} → ${draftLot.trendFixedLot.toFixed(2)}\nSideway risk: ${savedLot.sidewayRiskPercent.toFixed(2)}% → ${draftLot.sidewayRiskPercent.toFixed(2)}%\nSideway max lot: ${savedLot.sidewayMaxLot.toFixed(2)} → ${draftLot.sidewayMaxLot.toFixed(2)}\n\nKhông thay đổi vị thế đang mở. Fixed TP canonical được giữ nguyên.`,
    );
    if (confirmed) {
      mutation.mutate({ ...draftLot, ...canonicalFixedTp });
    }
  };

  const reset = () => {
    if (!savedLot) return;
    setTrendFixedLot(savedLot.trendFixedLot.toFixed(2));
    setSidewayRiskPercent(savedLot.sidewayRiskPercent.toFixed(2));
    setSidewayMaxLot(savedLot.sidewayMaxLot.toFixed(2));
  };

  return (
    <Card variant="outlined" sx={{ borderRadius: 4, height: "100%" }}>
      <CardContent sx={{ p: { xs: 2, md: 2.5 } }}>
        <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" gap={1.5}>
          <Box>
            <Typography variant="overline" color="primary" fontWeight={950}>CẤU HÌNH RỦI RO</Typography>
            <Typography variant="h5" fontWeight={950}>Lệnh mới</Typography>
            <Typography variant="body2" color="text.secondary" mt={0.5}>
              Cấu hình lot/risk canonical. Không chỉnh vị thế đang mở.
            </Typography>
          </Box>
          <Chip
            size="small"
            label={canSafelyApply ? "SAFETY PASS" : "SAFETY LOCKED"}
            color={canSafelyApply ? "success" : "warning"}
            variant="outlined"
            sx={{ fontWeight: 900, alignSelf: "flex-start" }}
          />
        </Stack>

        {query.isError && !query.data ? (
          <Alert severity="error" sx={{ mt: 2 }}>
            Không đọc được cấu hình risk: {query.error instanceof Error ? query.error.message : "lỗi không xác định"}
          </Alert>
        ) : null}

        <Box mt={1.5}>
          <RiskRow label="Trend Fixed Lot" valueText={savedLot ? savedLot.trendFixedLot.toFixed(2) : "—"} strong />
          <RiskRow label="Sideway Risk" valueText={savedLot ? `${savedLot.sidewayRiskPercent.toFixed(2)}%` : "—"} />
          <RiskRow label="Sideway Max Lot" valueText={savedLot ? savedLot.sidewayMaxLot.toFixed(2) : "—"} />
          <RiskRow label="Áp dụng" valueText="NEW POSITIONS ONLY" />
        </Box>

        <Stack direction="row" spacing={0.8} useFlexGap flexWrap="wrap" mt={1.5}>
          <Chip size="small" label="✓ Không Martingale" variant="outlined" color="success" />
          <Chip size="small" label="✓ Không Recovery Lot" variant="outlined" color="success" />
          <Chip size="small" label="✓ Lot step 0.03" variant="outlined" />
        </Stack>

        <Typography variant="caption" color="text.secondary" display="block" mt={1.5}>
          Fixed TP: xem tại Trung tâm điều khiển. Khi lưu risk, Fixed TP canonical hiện hành được giữ nguyên.
        </Typography>

        <Button
          variant={editorOpen ? "outlined" : "contained"}
          onClick={onToggleEditor}
          sx={{ mt: 2, fontWeight: 950 }}
        >
          {editorOpen ? "Ẩn chỉnh cấu hình" : "Chỉnh cấu hình"}
        </Button>

        {editorOpen ? (
          <Stack spacing={1.6} mt={2}>
            {!canSafelyApply ? (
              <Alert severity="warning">
                Khóa chỉnh risk: yêu cầu BOT_MODE=PAUSE và XAUUSD positions = 0. Hiện tại: mode {activeMode}, positions {openPositions}.
              </Alert>
            ) : null}
            {!canonicalFixedTp ? (
              <Alert severity="warning">
                Chưa đọc được Fixed TP canonical; lưu risk bị khóa để tránh thay đổi Fixed TP ngoài ý muốn.
              </Alert>
            ) : null}
            {validationErrors.length > 0 ? <Alert severity="error">{validationErrors.join(" ")}</Alert> : null}
            {mutation.isError ? (
              <Alert severity="error">
                Không lưu được risk: {mutation.error instanceof Error ? mutation.error.message : "lỗi không xác định"}
              </Alert>
            ) : null}
            {mutation.isSuccess ? (
              <Alert severity="success">Đã lưu risk cho lệnh mới và giữ nguyên Fixed TP canonical.</Alert>
            ) : null}

            <TextField
              label="Trend fixed lot"
              type="number"
              value={trendFixedLot}
              onChange={(event) => setTrendFixedLot(event.target.value)}
              inputProps={{ min: 0.03, max: 1.2, step: MANAGED_LOT_STEP }}
              helperText="0.03–1.20 · bước 0.03"
              fullWidth
            />
            <TextField
              label="Sideway risk percent"
              type="number"
              value={sidewayRiskPercent}
              onChange={(event) => setSidewayRiskPercent(event.target.value)}
              inputProps={{ min: 0.01, max: 1, step: 0.01 }}
              helperText="0.01–1.00% · bước 0.01%"
              fullWidth
            />
            <TextField
              label="Sideway max lot"
              type="number"
              value={sidewayMaxLot}
              onChange={(event) => setSidewayMaxLot(event.target.value)}
              inputProps={{ min: 0.03, max: 1.2, step: MANAGED_LOT_STEP }}
              helperText="0.03–1.20 · bước 0.03"
              fullWidth
            />

            <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
              <Button
                variant="contained"
                onClick={onSubmit}
                disabled={mutation.isPending || !savedLot || !canonicalFixedTp || !canSafelyApply || validationErrors.length > 0 || !hasChanges}
                sx={{ fontWeight: 950, flex: 1 }}
              >
                {mutation.isPending ? "Đang lưu..." : "Lưu cấu hình rủi ro"}
              </Button>
              <Button
                variant="outlined"
                onClick={reset}
                disabled={mutation.isPending || !savedLot || !hasChanges}
                sx={{ fontWeight: 900 }}
              >
                Khôi phục
              </Button>
            </Stack>
          </Stack>
        ) : null}
      </CardContent>
    </Card>
  );
}
