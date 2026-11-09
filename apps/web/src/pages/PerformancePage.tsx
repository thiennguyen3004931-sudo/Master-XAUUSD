import { useState } from "react";
import {
  Alert,
  Box,
  Card,
  CardContent,
  Chip,
  Grid,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";

import { useMt5Performance } from "../hooks";
import type {
  Mt5PerformanceBucket,
  Mt5PerformanceMetrics,
} from "../types";
import { ErrorState, LoadingState } from "../ui/PageState";
import { MetricCard } from "../ui/MetricCard";
import { Sparkline } from "../ui/Sparkline";

function money(value: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function pf(value: number | null): string {
  return value === null ? "∞" : value.toFixed(2);
}

function dateTime(value: number): string {
  return new Date(value).toLocaleString("vi-VN");
}

function MetricGrid({ metrics, currency }: { metrics: Mt5PerformanceMetrics; currency: string }) {
  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, sm: 6, xl: 3 }}>
        <MetricCard label="Lãi/lỗ ròng" value={money(metrics.netPnl, currency)} detail={`${metrics.totalTrades} lệnh`} tone={metrics.netPnl >= 0 ? "success.main" : "error.main"} />
      </Grid>
      <Grid size={{ xs: 12, sm: 6, xl: 3 }}>
        <MetricCard label="Tỷ lệ thắng" value={`${metrics.winRatePercent.toFixed(1)}%`} detail={`${metrics.wins} thắng · ${metrics.losses} thua`} />
      </Grid>
      <Grid size={{ xs: 12, sm: 6, xl: 3 }}>
        <MetricCard label="Profit Factor" value={pf(metrics.profitFactor)} detail={`Kỳ vọng ${money(metrics.expectancy, currency)}`} tone={(metrics.profitFactor ?? 999) >= 1 ? "success.main" : "error.main"} />
      </Grid>
      <Grid size={{ xs: 12, sm: 6, xl: 3 }}>
        <MetricCard label="Sụt giảm tối đa" value={`${metrics.maxDrawdownPercent.toFixed(2)}%`} detail={money(metrics.maxDrawdown, currency)} tone="error.main" />
      </Grid>
    </Grid>
  );
}

function BreakdownTable({ title, rows, currency, minimumSample }: { title: string; rows: Mt5PerformanceBucket[]; currency: string; minimumSample?: number }) {
  return (
    <Card sx={{ height: "100%" }}>
      <CardContent>
        <Typography fontWeight={800}>{title}</Typography>
        <TableContainer sx={{ mt: 1, maxHeight: 310 }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell>Nhóm</TableCell>
                <TableCell align="right">Số lệnh</TableCell>
                <TableCell align="right">Tỷ lệ thắng</TableCell>
                <TableCell align="right">Lãi/lỗ</TableCell>
                <TableCell align="right">PF</TableCell>
                {minimumSample !== undefined ? <TableCell align="right">Mẫu</TableCell> : null}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell>{row.label}</TableCell>
                  <TableCell align="right">{row.totalTrades}</TableCell>
                  <TableCell align="right">{row.winRatePercent.toFixed(1)}%</TableCell>
                  <TableCell align="right" sx={{ color: row.netPnl >= 0 ? "success.main" : "error.main" }}>{money(row.netPnl, currency)}</TableCell>
                  <TableCell align="right">{pf(row.profitFactor)}</TableCell>
                  {minimumSample !== undefined ? (
                    <TableCell align="right">
                      <Chip
                        size="small"
                        variant="outlined"
                        color={row.totalTrades >= minimumSample ? "success" : "warning"}
                        label={row.totalTrades >= minimumSample ? "ĐỦ MẪU" : `${row.totalTrades}/${minimumSample}`}
                      />
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </CardContent>
    </Card>
  );
}

export function PerformancePage() {
  const [days, setDays] = useState(90);
  const query = useMt5Performance(days);

  if (query.isLoading) return <LoadingState />;
  if (!query.data) {
    return <ErrorState message={query.error instanceof Error ? query.error.message : "Không đọc được hiệu suất MT5."} />;
  }

  const data = query.data;
  const all = data.accountWide.metrics;
  const system = data.systemOwned.metrics;
  const curve = data.accountWide.equityCurve;
  const accountMode = data.account.accountMode;
  const accountSummary = [
    data.account.login ? `#${data.account.login}` : null,
    data.account.server,
  ].filter(Boolean).join(" · ");

  return (
    <Stack spacing={2}>
      <Box>
        <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" gap={2}>
          <Box>
            <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
              <Typography variant="overline" color="primary" fontWeight={800}>MT5 {accountMode} · CHỈ ĐỌC</Typography>
              <Chip size="small" label={accountMode} color={accountMode === "LIVE" ? "warning" : "success"} variant="outlined" />
            </Stack>
            <Typography variant="h5" fontWeight={800}>Hiệu suất chiến lược</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              Lịch sử deal của tài khoản MT5 đang được chọn{accountSummary ? ` · ${accountSummary}` : ""}. Tách riêng TREND, SIDEWAY, BUY/SELL và phiên giao dịch để đánh giá Bot.
            </Typography>
          </Box>

          <TextField select size="small" label="Khoảng thời gian" value={days} onChange={(event) => setDays(Number(event.target.value))} sx={{ minWidth: 160 }}>
            {[30, 90, 180, 365].map((value) => <MenuItem key={value} value={value}>{value} ngày</MenuItem>)}
          </TextField>
        </Stack>
      </Box>

      <Alert severity={accountMode === "LIVE" ? "warning" : "info"}>
        Trang hiệu suất chỉ đọc lịch sử của tài khoản {accountMode} hiện tại. Không đổi chiến lược, không gửi order và không mutate position từ trang này.
      </Alert>

      <Typography fontWeight={800}>Toàn bộ tài khoản MT5 {accountMode}</Typography>
      <MetricGrid metrics={all} currency={data.currency} />

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, xl: 6 }}>
          <Card><CardContent><Typography fontWeight={800}>Đường tăng/giảm số dư</Typography><Box sx={{ mt: 2 }}><Sparkline values={curve.map((point) => point.balance)} positive={all.netPnl >= 0} /></Box></CardContent></Card>
        </Grid>
        <Grid size={{ xs: 12, xl: 6 }}>
          <Card><CardContent><Typography fontWeight={800}>Đường sụt giảm tài khoản</Typography><Box sx={{ mt: 2 }}><Sparkline values={curve.map((point) => point.drawdownPercent)} positive={false} /></Box></CardContent></Card>
        </Grid>
      </Grid>

      <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" alignItems={{ md: "center" }} gap={1}>
        <Box>
          <Typography fontWeight={800}>Các lệnh do hệ thống thực hiện</Typography>
          <Typography variant="caption" color="text.secondary">Chỉ tính các lệnh đúng magic của hệ thống và loại các lệnh validation/gate.</Typography>
        </Box>
        <Chip color={data.systemOwned.sampleReady ? "success" : "warning"} label={data.systemOwned.sampleReady ? "ĐỦ MẪU ĐÁNH GIÁ" : `${system.totalTrades}/${data.systemOwned.minimumRecommendationSample} LỆNH`} />
      </Stack>

      <MetricGrid metrics={system} currency={data.currency} />

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, xl: 6 }}><BreakdownTable title="Theo chiến lược TREND / SIDEWAY" rows={data.breakdown.strategy} currency={data.currency} minimumSample={data.systemOwned.minimumRecommendationSample} /></Grid>
        <Grid size={{ xs: 12, xl: 6 }}><BreakdownTable title="So sánh MUA và BÁN" rows={data.breakdown.side} currency={data.currency} /></Grid>
        <Grid size={{ xs: 12, xl: 6 }}><BreakdownTable title="Theo phiên giao dịch" rows={data.breakdown.session} currency={data.currency} /></Grid>
        <Grid size={{ xs: 12, xl: 6 }}><BreakdownTable title="Theo ngày trong tuần" rows={data.breakdown.weekday} currency={data.currency} /></Grid>
        <Grid size={{ xs: 12, xl: 6 }}><BreakdownTable title="Theo nguồn lệnh" rows={data.breakdown.ownership} currency={data.currency} /></Grid>
      </Grid>

      <Card>
        <CardContent>
          <Typography fontWeight={800}>Nhận xét và đề xuất</Typography>
          <Stack spacing={1.5} sx={{ mt: 2 }}>
            {data.recommendations.map((item) => (
              <Alert key={`${item.severity}-${item.title}`} severity={item.severity === "ACTION" ? "error" : item.severity === "WATCH" ? "warning" : "info"}>
                <Typography fontWeight={800}>{item.title}</Typography>
                <Typography variant="body2" sx={{ mt: 0.5 }}>{item.evidence}</Typography>
                <Typography variant="body2" sx={{ mt: 0.5 }}>→ {item.suggestion}</Typography>
              </Alert>
            ))}
          </Stack>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography fontWeight={800}>Lịch sử lệnh MT5 {accountMode}</Typography>
          <TableContainer sx={{ mt: 1, maxHeight: 560 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell>Thời điểm đóng</TableCell>
                  <TableCell>Hướng</TableCell>
                  <TableCell>Chiến lược</TableCell>
                  <TableCell>Nguồn</TableCell>
                  <TableCell>Phiên</TableCell>
                  <TableCell align="right">Lot</TableCell>
                  <TableCell align="right">Giá vào</TableCell>
                  <TableCell align="right">Giá thoát</TableCell>
                  <TableCell align="right">Phút</TableCell>
                  <TableCell align="right">Lãi/lỗ</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.trades.map((trade) => (
                  <TableRow key={trade.id}>
                    <TableCell>{dateTime(trade.closedAt)}</TableCell>
                    <TableCell><Chip size="small" label={trade.side === "BUY" ? "MUA" : "BÁN"} color={trade.side === "BUY" ? "success" : "error"} variant="outlined" /></TableCell>
                    <TableCell>{trade.strategy}</TableCell>
                    <TableCell>{trade.ownership}</TableCell>
                    <TableCell>{trade.session}</TableCell>
                    <TableCell align="right">{trade.volume.toFixed(2)}</TableCell>
                    <TableCell align="right">{trade.entry.toFixed(2)}</TableCell>
                    <TableCell align="right">{trade.exit.toFixed(2)}</TableCell>
                    <TableCell align="right">{trade.durationMinutes.toFixed(1)}</TableCell>
                    <TableCell align="right" sx={{ color: trade.netPnl >= 0 ? "success.main" : "error.main", fontWeight: 800 }}>{money(trade.netPnl, data.currency)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>

      <Alert severity="warning">Lý do thoát hiện có thể hiển thị chưa đầy đủ nếu payload deal MT5 không cung cấp trường reason. Hệ thống không tự suy đoán SL/TP khi dữ liệu thiếu.</Alert>
    </Stack>
  );
}
