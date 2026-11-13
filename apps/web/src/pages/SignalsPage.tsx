import type { ReactNode } from "react";
import {
  Box,
  Card,
  CardContent,
  Chip,
  Divider,
  Grid,
  Stack,
  Typography,
} from "@mui/material";
import { useDashboard } from "../hooks";
import { ErrorState, LoadingState } from "../ui/PageState";
import { StatusChip } from "../ui/StatusChip";
import { price } from "../format";

function strengthLabel(strength: string) {
  const normalized = strength.trim().toUpperCase();
  if (normalized.includes("HIGH") || normalized.includes("STRONG")) return "CAO";
  if (normalized.includes("MEDIUM") || normalized.includes("MODERATE")) return "TRUNG BÌNH";
  if (normalized.includes("LOW") || normalized.includes("WEAK")) return "THẤP";
  return strength || "CHƯA XÁC ĐỊNH";
}

function conclusionText(
  direction: "BUY" | "SELL" | "WAIT",
  strategyAction: "EXECUTE" | "WAIT" | "REJECT",
  riskApproved: boolean,
) {
  if (direction === "WAIT") return "CHƯA VÀO LỆNH — tiếp tục chờ setup hợp lệ.";
  if (!riskApproved || strategyAction === "REJECT") {
    return "CHƯA VÀO LỆNH — Risk/Strategy gate đang chặn kế hoạch hiện tại.";
  }
  if (strategyAction === "EXECUTE") {
    return `Có thể chuẩn bị ${direction} khi điều kiện entry hoàn tất.`;
  }
  return `Đang nghiêng về ${direction}, nhưng bot vẫn chờ gate cuối hoàn tất.`;
}

function decisionStatus(
  direction: "BUY" | "SELL" | "WAIT",
  strategyAction: "EXECUTE" | "WAIT" | "REJECT",
  riskApproved: boolean,
) {
  if (direction === "WAIT" || strategyAction === "WAIT") return "CHỜ";
  if (!riskApproved || strategyAction === "REJECT") return "BỊ CHẶN";
  return "ĐỦ ĐIỀU KIỆN";
}

export function SignalsPage() {
  const query = useDashboard();
  if (query.isLoading) return <LoadingState />;
  if (!query.data) return <ErrorState message="Không có dữ liệu Signal Engine." />;

  const { signal, analysis, strategy, risk, market, account } = query.data;
  const recommendedBot = strategy.regime?.trim() || "CHƯA XÁC ĐỊNH";
  const status = decisionStatus(signal.direction, strategy.action, risk.approved);
  const conclusion = conclusionText(signal.direction, strategy.action, risk.approved);
  const signalBorderColor =
    signal.direction === "BUY"
      ? "success.main"
      : signal.direction === "SELL"
        ? "error.main"
        : "warning.main";
  const metricEntry = signal.entry === null && signal.direction === "WAIT" ? "CHỜ" : price(signal.entry);
  const metricRiskReward = signal.riskReward === null ? "—" : `1 : ${signal.riskReward.toFixed(2)}`;
  const riskReason = risk.approved
    ? "APPROVED"
    : risk.rejectionCodes.join(", ") || "BLOCKED";
  const strategyReason = strategy.rejectionCodes.join(", ") || "Không có rejection code";

  return (
    <Stack spacing={2}>
      <Header
        eyebrow="PACK 05"
        title="Signal Engine"
        subtitle="Tín hiệu đề xuất để quan sát và kiểm tra logic. Không có nút gửi lệnh trực tiếp."
      />

      <Card sx={{ border: "1px solid", borderColor: signalBorderColor }}>
        <CardContent>
          <Stack spacing={2.5}>
            <Stack
              direction={{ xs: "column", md: "row" }}
              justifyContent="space-between"
              gap={2}
              alignItems={{ md: "flex-start" }}
            >
              <Box>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Typography variant="overline" color="text.secondary" fontWeight={900}>
                    TÍN HIỆU ĐỀ XUẤT
                  </Typography>
                  <Chip label={`${market.symbol} · ${account.accountType}`} size="small" variant="outlined" />
                  <Chip label="READ ONLY" size="small" variant="outlined" />
                </Stack>
                <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mt: 1 }}>
                  <Typography variant="h2" fontWeight={950} lineHeight={1}>
                    {signal.direction}
                  </Typography>
                  <StatusChip value={signal.direction} />
                </Stack>
                <Typography variant="h4" fontWeight={900} sx={{ mt: 1.5 }}>
                  {signal.confidence.toFixed(1)}%
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Độ tin cậy {strengthLabel(signal.strength)} · {signal.strength}
                </Typography>
              </Box>

              <Stack spacing={1.2} sx={{ minWidth: { md: 270 } }}>
                <HeroInfo label="BOT ĐỀ XUẤT" value={recommendedBot} />
                <HeroInfo label="TRẠNG THÁI" value={status} />
                <HeroInfo label="STRATEGY ACTION" value={strategy.action} />
              </Stack>
            </Stack>

            <Divider />

            <Grid container spacing={1.5}>
              {[
                ["Entry", metricEntry],
                ["Stop Loss", price(signal.stopLoss)],
                ["Take Profit", price(signal.takeProfit)],
                ["R:R", metricRiskReward],
              ].map(([label, value]) => (
                <Grid size={{ xs: 6, md: 3 }} key={label}>
                  <Box className="mini-card" sx={{ height: "100%", p: 1.6 }}>
                    <Typography variant="caption" color="text.secondary">
                      {label}
                    </Typography>
                    <Typography variant="h6" fontWeight={900} sx={{ mt: 0.5 }}>
                      {value}
                    </Typography>
                  </Box>
                </Grid>
              ))}
            </Grid>
          </Stack>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="h6" fontWeight={900}>
            TẠI SAO BOT ĐỀ XUẤT NHƯ VẬY?
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.6 }}>
            Tóm tắt các gate đang quyết định tín hiệu hiện tại; đây là phần giải thích, không phải nút thực thi lệnh.
          </Typography>

          <Grid container spacing={1.5} sx={{ mt: 0.5 }}>
            <Grid size={{ xs: 12, md: 4 }}>
              <GateBox
                title="Analysis"
                value={`${analysis.trend} · ${analysis.structure}`}
                detail={`Score ${analysis.score.toFixed(1)}`}
              />
            </Grid>
            <Grid size={{ xs: 12, md: 4 }}>
              <GateBox
                title="Risk Gate"
                value={risk.approved ? "APPROVED" : "BLOCKED"}
                detail={riskReason}
              />
            </Grid>
            <Grid size={{ xs: 12, md: 4 }}>
              <GateBox
                title="Strategy"
                value={`${strategy.action} · ${recommendedBot}`}
                detail={strategyReason}
              />
            </Grid>
          </Grid>

          <Stack spacing={1.2} sx={{ mt: 2 }}>
            {signal.reasons.length > 0 ? (
              signal.reasons.map((reason, index) => (
                <Box key={`${index}-${reason}`} className="reason-row">
                  <span>{index + 1}</span>
                  <Typography variant="body2">{reason}</Typography>
                </Box>
              ))
            ) : (
              <Typography variant="body2" color="text.secondary">
                Chưa có reason chi tiết từ Signal Engine.
              </Typography>
            )}
          </Stack>

          <Box
            sx={{
              mt: 2,
              p: 1.8,
              borderRadius: 2,
              border: "1px solid",
              borderColor: signalBorderColor,
              bgcolor: "rgba(255,255,255,.015)",
            }}
          >
            <Typography variant="caption" color="text.secondary" fontWeight={900}>
              KẾT LUẬN
            </Typography>
            <Typography variant="body1" fontWeight={850} sx={{ mt: 0.5 }}>
              {conclusion}
            </Typography>
          </Box>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="h6" fontWeight={900}>
            CHI TIẾT PHÂN TÍCH
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.6 }}>
            Dữ liệu chi tiết giữ nguyên từ Dashboard Snapshot để đối chiếu nhanh khi cần kiểm tra sâu.
          </Typography>

          <Grid container spacing={2} sx={{ mt: 0.5 }}>
            <Grid size={{ xs: 12, md: 4 }}>
              <DetailGroup title="ANALYSIS">
                <Info label="Trend" value={analysis.trend} />
                <Info label="Structure" value={analysis.structure} />
                <Info label="Score" value={analysis.score.toFixed(1)} />
                <Info label="Data quality" value={`${analysis.dataQuality.toFixed(1)}%`} />
                <Info label="Volatility" value={`${analysis.volatilityPercent.toFixed(2)}%`} />
              </DetailGroup>
            </Grid>
            <Grid size={{ xs: 12, md: 4 }}>
              <DetailGroup title="STRATEGY">
                <Info label="Action" value={strategy.action} />
                <Info label="Regime" value={recommendedBot} />
                <Info label="Strategy ID" value={strategy.strategyId ?? "—"} />
                <Info label="Confidence" value={`${strategy.confidence.toFixed(1)}%`} />
                <Info label="Regime confidence" value={`${strategy.regimeConfidence.toFixed(1)}%`} />
              </DetailGroup>
            </Grid>
            <Grid size={{ xs: 12, md: 4 }}>
              <DetailGroup title="RISK">
                <Info label="Status" value={risk.approved ? "APPROVED" : "BLOCKED"} />
                <Info label="Risk" value={`${risk.riskPercent.toFixed(2)}%`} />
                <Info label="Position size" value={risk.positionSize.toFixed(2)} />
                <Info label="Daily loss" value={`${risk.dailyLossPercent.toFixed(2)}%`} />
                <Info
                  label="Rejection"
                  value={risk.rejectionCodes.join(", ") || signal.rejectionCodes.join(", ") || "—"}
                />
              </DetailGroup>
            </Grid>
          </Grid>
        </CardContent>
      </Card>
    </Stack>
  );
}

function Header({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
}) {
  return (
    <Box>
      <Typography variant="overline" color="primary" fontWeight={800}>
        {eyebrow}
      </Typography>
      <Typography variant="h5" fontWeight={800}>
        {title}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
        {subtitle}
      </Typography>
    </Box>
  );
}

function HeroInfo({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" fontWeight={850}>
        {label}
      </Typography>
      <Typography variant="body1" fontWeight={900}>
        {value}
      </Typography>
    </Box>
  );
}

function GateBox({ title, value, detail }: { title: string; value: string; detail: string }) {
  return (
    <Box
      sx={{
        height: "100%",
        p: 1.7,
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 2,
        bgcolor: "rgba(255,255,255,.015)",
      }}
    >
      <Typography variant="caption" color="text.secondary" fontWeight={850}>
        {title}
      </Typography>
      <Typography variant="body1" fontWeight={900} sx={{ mt: 0.4 }}>
        {value}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
        {detail}
      </Typography>
    </Box>
  );
}

function DetailGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box
      sx={{
        height: "100%",
        p: 1.7,
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 2,
      }}
    >
      <Typography variant="caption" color="primary" fontWeight={900} letterSpacing=".06em">
        {title}
      </Typography>
      <Stack spacing={1.1} sx={{ mt: 1.2 }}>
        {children}
      </Stack>
    </Box>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <Stack direction="row" justifyContent="space-between" gap={2} alignItems="flex-start">
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="caption" fontWeight={800} textAlign="right" sx={{ overflowWrap: "anywhere" }}>
        {value}
      </Typography>
    </Stack>
  );
}
