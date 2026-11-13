import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Card,
  CardContent,
  Chip,
  Grid,
  LinearProgress,
  Stack,
  Typography,
} from "@mui/material";

export interface DetectedPatternRuleCheckDto {
  code: string;
  label: string;
  passed: boolean;
  observed: string;
  required: string;
}

export interface DetectedMarketPatternDto {
  id: string;
  nameVi: string;
  nameEn: string;
  category: "CANDLESTICK" | "CHART_STRUCTURE";
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  status: "ACTIVE" | "FORMING" | "INACTIVE";
  matchScore: number;
  timeframe: "M15" | "M5" | "M15+M5";
  summaryVi: string;
  targetStrategy: "TREND" | "SIDEWAY" | "PAUSE";
  recommendedSide: "BUY" | "SELL" | "WAIT";
  entryZone: { price: number; mode: "ENTRY_IMMEDIATE" | "WAIT_PULLBACK" | "WAIT" } | null;
  stopLossPrice: number | null;
  structuralStopDistance: number | null;
  tp1Price: number | null;
  tp2Price: number | null;
  checks: DetectedPatternRuleCheckDto[];
}

export interface Phase7CPatternAdvisorDto {
  schemaVersion: 1;
  generatedAt: number;
  symbol: string;
  timeframe: "M15";
  currentPrice: number;
  activePrimaryPattern: DetectedMarketPatternDto | null;
  activeCandlestickPattern: DetectedMarketPatternDto | null;
  activeChartStructurePattern: DetectedMarketPatternDto | null;
  patterns: DetectedMarketPatternDto[];
  strategyAdvice: {
    currentBotMode: string;
    recommendedBotMode: "AUTO" | "TREND" | "SIDEWAY" | "SEMI" | "PAUSE";
    modeChangeNeeded: boolean;
    recommendedStrategy: "TREND" | "SIDEWAY" | "PAUSE";
    recommendedSide: "BUY" | "SELL" | "WAIT";
    entryExecutionMode: "ENTRY_IMMEDIATE" | "WAIT_PULLBACK" | "BLOCKED_WAIT";
    headlineVi: string;
    rationaleVi: string[];
    riskPlan: {
      recommendedLot: number;
      initialSlPrice: number | null;
      slDistancePrice: number | null;
      breakEvenTriggerPrice: number | null;
      partialCloseTriggerPrice: number | null;
      partialCloseLot: number;
      runnerLot: number;
      takeProfitPrice: number | null;
    };
  };
}

async function fetchPatternAdvisor(symbol = "XAUUSD"): Promise<Phase7CPatternAdvisorDto> {
  const urls = [
    `/api/v1/phase7c/pattern-advisor?symbol=${encodeURIComponent(symbol)}`,
    `http://127.0.0.1:3711/api/v1/phase7c/pattern-advisor?symbol=${encodeURIComponent(symbol)}`,
  ];
  const errors: string[] = [];
  for (const url of urls) {
    try {
      const response = await fetch(url, { cache: "no-store", headers: { accept: "application/json" } });
      const text = await response.text();
      if (response.ok) return JSON.parse(text) as Phase7CPatternAdvisorDto;
      errors.push(`HTTP ${response.status}`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Fetch error");
    }
  }
  throw new Error(errors.join(" | "));
}

export function Phase7CChartPatternAdvisorCard() {
  const query = useQuery({
    queryKey: ["phase7c-pattern-advisor", "XAUUSD"],
    queryFn: () => fetchPatternAdvisor("XAUUSD"),
    refetchInterval: 5000,
    retry: false,
  });

  const data = query.data;

  return (
    <Card variant="outlined" sx={{ borderRadius: 4, bgcolor: "rgba(7,14,25,.78)" }}>
      <CardContent sx={{ p: { xs: 2, md: 2.6 } }}>
        <Stack spacing={2}>
          <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" gap={1}>
            <Box>
              <Typography variant="overline" color="primary" fontWeight={950}>
                NHẬN DIỆN BIỂU ĐỒ MẪU &amp; CỐ VẤN CHIẾN LƯỢC DỮ LIỆU
              </Typography>
              <Typography variant="h6" fontWeight={950}>
                HIỆN TẠI ĐANG Ở MÔ HÌNH NÀO &amp; ĐỀ XUẤT CHIẾN LƯỢC
              </Typography>
            </Box>
            {data?.activePrimaryPattern ? (
              <Chip
                color={
                  data.activePrimaryPattern.direction === "BULLISH"
                    ? "success"
                    : data.activePrimaryPattern.direction === "BEARISH"
                      ? "error"
                      : "warning"
                }
                label={`${data.activePrimaryPattern.nameVi} · ${data.activePrimaryPattern.matchScore}%`}
                sx={{ fontWeight: 900, alignSelf: "flex-start" }}
              />
            ) : null}
          </Stack>

          {!data ? (
            <Alert severity="info" variant="outlined">
              Đang kết nối bộ nhận diện mẫu hình nến &amp; cấu trúc thị trường XAUUSD M15/M5...
            </Alert>
          ) : (
            <>
              <Alert
                severity={data.strategyAdvice.modeChangeNeeded ? "warning" : "success"}
                variant="outlined"
              >
                <Typography variant="subtitle2" fontWeight={950}>
                  {data.strategyAdvice.headlineVi}
                </Typography>
                <Typography variant="caption" display="block" mt={0.5}>
                  Mode hiện tại: {data.strategyAdvice.currentBotMode} · Đề xuất Mode: {data.strategyAdvice.recommendedBotMode} ({data.strategyAdvice.recommendedStrategy}) · Chế độ vào lệnh: {data.strategyAdvice.entryExecutionMode}
                </Typography>
              </Alert>

              <Grid container spacing={2}>
                {data.patterns.map((pattern) => (
                  <Grid size={{ xs: 12, md: 6 }} key={pattern.id}>
                    <Box
                      sx={{
                        p: 1.6,
                        borderRadius: 3,
                        border:
                          pattern.status === "ACTIVE"
                            ? "1px solid rgba(16,185,129,.55)"
                            : "1px solid rgba(148,163,184,.14)",
                        bgcolor: "rgba(15,23,42,.45)",
                      }}
                    >
                      <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
                        <Typography variant="subtitle2" fontWeight={950}>
                          {pattern.nameVi}
                        </Typography>
                        <Chip
                          size="small"
                          color={pattern.status === "ACTIVE" ? "success" : pattern.status === "FORMING" ? "warning" : "default"}
                          label={`${pattern.status} · ${pattern.matchScore}%`}
                          sx={{ fontWeight: 900 }}
                        />
                      </Stack>
                      <LinearProgress
                        variant="determinate"
                        value={pattern.matchScore}
                        color={pattern.direction === "BULLISH" ? "success" : pattern.direction === "BEARISH" ? "error" : "warning"}
                        sx={{ my: 1, height: 6, borderRadius: 4 }}
                      />
                      <Typography variant="caption" color="text.secondary" display="block">
                        {pattern.summaryVi}
                      </Typography>
                    </Box>
                  </Grid>
                ))}
              </Grid>
            </>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}
