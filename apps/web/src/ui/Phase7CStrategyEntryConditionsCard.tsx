import { useMemo, useState } from "react";
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
  Typography,
} from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const STRATEGY_ENTRY_URL = "/api/v1/phase7c/strategy-entry-conditions";
const DECISION_MONITOR_URL = "/api/v1/phase7c/decision-monitor?symbol=XAUUSD";
const CONTROL_BASE = "http://127.0.0.1:3711";

const TREND_IDS = [
  "patternM15",
  "supertrendM15",
  "supertrendM5",
  "validTrendStructure",
  "ma20Ma50",
  "fvg",
] as const;
const SIDEWAY_IDS = [
  "rangingRegime",
  "recommendedModeSideway",
  "minimumRegimeConfidence",
  "supplyDemandRange",
  "rangeEdge",
  "m5Confirmation",
] as const;

const MANDATORY_TREND = new Set(["patternM15"]);
const MANDATORY_SIDEWAY = new Set(["rangeEdge"]);

type TrendId = (typeof TREND_IDS)[number];
type SidewayId = (typeof SIDEWAY_IDS)[number];
type ConditionSet<T extends string> = Record<T, boolean>;
type DraftState = {
  trend: ConditionSet<TrendId>;
  sideway: ConditionSet<SidewayId>;
};
type EntryState = DraftState & {
  version: number;
  updatedAt: string;
  updatedBy: string;
};
type ConditionStatus = "PASS" | "FAIL" | "IGNORED";
type Evaluation = {
  configVersion?: number;
  allEnabledPassed?: boolean;
  failedConditions?: string[];
  conditions?: Array<{ id?: string; enabled?: boolean; mandatory?: boolean; status?: ConditionStatus; observed?: unknown }>;
};
type EntryResponse = {
  state: EntryState | null;
  valid: boolean;
  persisted: boolean;
  editable: boolean;
  error: string | null;
  appliesTo: "NEW_ENTRIES_ONLY";
  sharedAcrossAccounts: boolean;
  guards?: Record<string, unknown>;
};
type DecisionResponse = {
  strategyEntryConditions?: {
    trend?: Evaluation | null;
    sideway?: Evaluation | null;
  };
};

const LABELS: Record<TrendId | SidewayId, string> = {
  patternM15: "Mô hình nến M15",
  supertrendM15: "Supertrend M15 cùng hướng",
  supertrendM5: "Supertrend M5 cùng hướng",
  validTrendStructure: "Cấu trúc xu hướng hợp lệ",
  ma20Ma50: "MA20 / MA50 cùng hướng",
  fvg: "FVG xác nhận",
  rangingRegime: "Regime RANGING",
  recommendedModeSideway: "Engine khuyến nghị SIDEWAY",
  minimumRegimeConfidence: "Độ tin cậy regime tối thiểu",
  supplyDemandRange: "Có vùng Supply / Demand",
  rangeEdge: "Giá ở biên range",
  m5Confirmation: "Xác nhận M5",
};

async function readJson<T>(path: string): Promise<T> {
  const errors: string[] = [];
  for (const url of [path, `${CONTROL_BASE}${path}`]) {
    try {
      const response = await fetch(url, { cache: "no-store", headers: { accept: "application/json" } });
      const text = await response.text();
      if (response.ok) return (text ? JSON.parse(text) : {}) as T;
      errors.push(`HTTP ${response.status}: ${text.slice(0, 180)}`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Không kết nối được");
    }
  }
  throw new Error(errors.join(" | "));
}

async function saveStrategyEntryConditions(state: EntryState, draft: DraftState) {
  const payload = {
    expectedVersion: state.version,
    source: "web-control-center",
    trend: draft.trend,
    sideway: draft.sideway,
  };
  const errors: string[] = [];
  for (const url of [STRATEGY_ENTRY_URL, `${CONTROL_BASE}${STRATEGY_ENTRY_URL}`]) {
    try {
      const response = await fetch(url, {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
      });
      const text = await response.text();
      const body = text ? JSON.parse(text) : {};
      if (response.ok) return body;
      const code = String(body?.code ?? "");
      if (code === "CONFIG_VERSION_CONFLICT") {
        throw new Error("CONFIG_VERSION_CONFLICT: cấu hình đã đổi ở nơi khác; tải lại trước khi lưu.");
      }
      errors.push(`${code ? `${code}: ` : ""}${String(body?.error ?? `HTTP ${response.status}`)}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("CONFIG_VERSION_CONFLICT")) throw error;
      errors.push(error instanceof Error ? error.message : "Không lưu được cấu hình");
    }
  }
  throw new Error(errors.join(" | "));
}

function statusFor(evaluation: Evaluation | null | undefined, id: string): ConditionStatus | "—" {
  return evaluation?.conditions?.find((row) => row.id === id)?.status ?? "—";
}

function statusColor(status: ConditionStatus | "—") {
  if (status === "PASS") return "success" as const;
  if (status === "FAIL") return "error" as const;
  if (status === "IGNORED") return "default" as const;
  return "default" as const;
}

function ConditionGroup<T extends TrendId | SidewayId>({
  title,
  ids,
  values,
  mandatoryIds,
  editable,
  evaluation,
  onToggle,
}: {
  title: string;
  ids: readonly T[];
  values: Record<T, boolean>;
  mandatoryIds: Set<string>;
  editable: boolean;
  evaluation: Evaluation | null | undefined;
  onToggle: (id: T, enabled: boolean) => void;
}) {
  return (
    <Box sx={{ border: "1px solid rgba(148,163,184,.14)", borderRadius: 3, p: 2 }}>
      <Typography fontWeight={950} mb={1}>{title}</Typography>
      <Stack spacing={0.8}>
        {ids.map((id) => {
          const mandatory = mandatoryIds.has(id);
          const status = statusFor(evaluation, id);
          return (
            <Stack key={id} direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ sm: "center" }} gap={1}>
              <FormControlLabel
                sx={{ m: 0 }}
                control={(
                  <Switch
                    checked={Boolean(values[id])}
                    disabled={mandatory || !editable}
                    onChange={(event) => onToggle(id, event.target.checked)}
                  />
                )}
                label={(
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="body2" fontWeight={800}>{LABELS[id]}</Typography>
                    {mandatory && <Chip size="small" label="BẮT BUỘC" variant="outlined" />}
                  </Stack>
                )}
              />
              <Chip size="small" label={status} color={statusColor(status)} variant="outlined" sx={{ fontWeight: 900, minWidth: 74 }} />
            </Stack>
          );
        })}
      </Stack>
    </Box>
  );
}

export function Phase7CStrategyEntryConditionsCard() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<DraftState | null>(null);

  const configQuery = useQuery({
    queryKey: ["phase7c-strategy-entry-conditions"],
    queryFn: () => readJson<EntryResponse>(STRATEGY_ENTRY_URL),
    refetchInterval: 5_000,
    retry: false,
    placeholderData: (previous) => previous,
  });
  const monitorQuery = useQuery({
    queryKey: ["phase7c-decision-monitor-entry-conditions"],
    queryFn: () => readJson<DecisionResponse>(DECISION_MONITOR_URL),
    refetchInterval: 3_000,
    retry: false,
    placeholderData: (previous) => previous,
  });

  const state = configQuery.data?.state ?? null;
  const editable = configQuery.data?.editable === true;
  const guards = configQuery.data?.guards ?? {};
  const strategyEntryConditions = monitorQuery.data?.strategyEntryConditions;

  const stateVersion = state?.version ?? null;
  const [syncedVersion, setSyncedVersion] = useState<number | null | undefined>(undefined);
  if (syncedVersion !== stateVersion) {
    setSyncedVersion(stateVersion);
    setDraft(state ? { trend: { ...state.trend }, sideway: { ...state.sideway } } : null);
  }

  const dirty = useMemo(() => {
    if (!state || !draft) return false;
    return TREND_IDS.some((id) => state.trend[id] !== draft.trend[id])
      || SIDEWAY_IDS.some((id) => state.sideway[id] !== draft.sideway[id]);
  }, [state, draft]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!state || !draft) throw new Error("Chưa có cấu hình hợp lệ để lưu.");
      return saveStrategyEntryConditions(state, draft);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["phase7c-strategy-entry-conditions"] }),
        queryClient.invalidateQueries({ queryKey: ["phase7c-decision-monitor-entry-conditions"] }),
      ]);
    },
  });

  const toggleTrend = (id: TrendId, enabled: boolean) => {
    if (!draft || MANDATORY_TREND.has(id)) return;
    setDraft({ ...draft, trend: { ...draft.trend, [id]: enabled } });
  };
  const toggleSideway = (id: SidewayId, enabled: boolean) => {
    if (!draft || MANDATORY_SIDEWAY.has(id)) return;
    setDraft({ ...draft, sideway: { ...draft.sideway, [id]: enabled } });
  };

  const save = () => {
    if (!state || !draft || !editable || !dirty || mutation.isPending) return;
    const confirmed = window.confirm(
      `Xác nhận lưu điều kiện vào lệnh phiên bản ${state.version}?\n\nThay đổi chỉ áp dụng cho NEW_ENTRIES_ONLY. Pattern M15 và Range Edge luôn bắt buộc.`,
    );
    if (confirmed) mutation.mutate();
  };

  return (
    <Card variant="outlined" sx={{ borderRadius: 4 }}>
      <CardContent sx={{ p: 3 }}>
        <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" gap={2}>
          <Box>
            <Typography variant="overline" color="primary" fontWeight={900}>ĐIỀU KIỆN VÀO LỆNH</Typography>
            <Typography variant="h5" fontWeight={950}>Trend & Sideway canonical conditions</Typography>
            <Typography variant="body2" color="text.secondary" mt={0.6}>
              Bật/tắt điều kiện thành phần. Trạng thái PASS / FAIL / IGNORED lấy từ decision monitor gần nhất; lưu cấu hình chỉ áp dụng cho NEW_ENTRIES_ONLY.
            </Typography>
          </Box>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignContent="flex-start">
            <Chip label={`Version ${state?.version ?? "—"}`} variant="outlined" />
            <Chip label={editable ? "CHO PHÉP CHỈNH" : "ĐANG KHÓA"} color={editable ? "success" : "warning"} variant="outlined" />
            <Chip label={configQuery.data?.persisted ? "ĐÃ LƯU" : "MẶC ĐỊNH AN TOÀN"} variant="outlined" />
          </Stack>
        </Stack>

        {configQuery.isError && <Alert severity="error" sx={{ mt: 2 }}>Không đọc được cấu hình điều kiện: {configQuery.error instanceof Error ? configQuery.error.message : "lỗi không xác định"}</Alert>}
        {configQuery.data && !configQuery.data.valid && <Alert severity="error" sx={{ mt: 2 }}>Cấu hình canonical không hợp lệ: {configQuery.data.error ?? "unknown"}</Alert>}
        {configQuery.data && !editable && (
          <Alert severity="warning" sx={{ mt: 2 }}>
            Khóa chỉnh sửa đang bật. Server yêu cầu BOT_MODE=PAUSE, account state hợp lệ, Bridge khớp tài khoản và XAUUSD positions = 0. Guards: {JSON.stringify(guards)}
          </Alert>
        )}
        {mutation.isError && <Alert severity="error" sx={{ mt: 2 }}>Không lưu được: {mutation.error instanceof Error ? mutation.error.message : "lỗi không xác định"}</Alert>}
        {mutation.isSuccess && <Alert severity="success" sx={{ mt: 2 }}>Đã lưu cấu hình điều kiện vào lệnh mới với optimistic version check.</Alert>}

        {draft && (
          <Grid container spacing={2} mt={0.5}>
            <Grid size={{ xs: 12, lg: 6 }}>
              <ConditionGroup
                title="TREND"
                ids={TREND_IDS}
                values={draft.trend}
                mandatoryIds={MANDATORY_TREND}
                editable={editable}
                evaluation={strategyEntryConditions?.trend}
                onToggle={toggleTrend}
              />
            </Grid>
            <Grid size={{ xs: 12, lg: 6 }}>
              <ConditionGroup
                title="SIDEWAY"
                ids={SIDEWAY_IDS}
                values={draft.sideway}
                mandatoryIds={MANDATORY_SIDEWAY}
                editable={editable}
                evaluation={strategyEntryConditions?.sideway}
                onToggle={toggleSideway}
              />
            </Grid>
          </Grid>
        )}

        <Stack direction="row" spacing={1.5} mt={2.5}>
          <Button
            variant="contained"
            disabled={!editable || !dirty || mutation.isPending || !state || !draft}
            onClick={save}
          >
            {mutation.isPending ? "ĐANG LƯU…" : "LƯU ĐIỀU KIỆN"}
          </Button>
          <Button
            variant="outlined"
            disabled={!dirty || !state}
            onClick={() => state && setDraft({ trend: { ...state.trend }, sideway: { ...state.sideway } })}
          >
            HOÀN TÁC
          </Button>
        </Stack>
      </CardContent>
    </Card>
  );
}
