import {
  Alert,
  Box,
  Card,
  CardContent,
  Grid,
  Stack,
  Typography,
} from "@mui/material";
import { useMt5Telemetry } from "../hooks";
import { dateTime, price } from "../format";
import { LoadingState } from "../ui/PageState";
import { StatusChip } from "../ui/StatusChip";

export function SystemPage() {
  const mt5 = useMt5Telemetry("XAUUSD");
  if (mt5.isLoading && !mt5.data) return <LoadingState />;

  const telemetry = mt5.data;
  const health = telemetry?.health;
  const ready = Boolean(
    telemetry?.reachable &&
    health?.accountMode === "demo" &&
    health?.tradingEnabled &&
    health?.terminalTradeAllowed &&
    health?.expertTradeAllowed,
  );

  return (
    <Stack spacing={2.2}>
      <Box>
        <Typography variant="overline" color="primary" fontWeight={900}>HỆ THỐNG DEMO</Typography>
        <Typography variant="h4" fontWeight={950}>Trạng thái hệ thống</Typography>
        <Typography variant="body2" color="text.secondary" mt={0.5}>Chỉ hiển thị đường vận hành MT5 DEMO hiện tại.</Typography>
      </Box>

      <Alert severity={ready ? "success" : "warning"}>
        {ready ? "MT5 DEMO, Bridge, Algo Trading và Expert Trading đều sẵn sàng." : "Hệ thống chưa đủ điều kiện chạy Bot DEMO."}
      </Alert>

      <Card variant="outlined">
        <CardContent>
          <Stack direction="row" justifyContent="space-between" gap={2} alignItems="center">
            <Typography variant="h6" fontWeight={900}>Kết nối MT5 Bridge</Typography>
            <StatusChip value={telemetry?.reachable ? "ĐANG KẾT NỐI" : "MẤT KẾT NỐI"} />
          </Stack>
          <Grid container spacing={1.5} mt={0.5}>
            <Info label="Loại tài khoản" value={health?.accountMode === "demo" ? "DEMO" : health?.accountMode?.toUpperCase() ?? "KHÔNG RÕ"} />
            <Info label="Máy chủ" value={health?.server ?? "—"} />
            <Info label="Cho phép Bridge giao dịch" value={health?.tradingEnabled ? "CÓ" : "KHÔNG"} />
            <Info label="Algo Trading trên MT5" value={health?.terminalTradeAllowed ? "ĐÃ BẬT" : "ĐANG TẮT"} />
            <Info label="Quyền Expert Trading" value={health?.expertTradeAllowed ? "ĐƯỢC PHÉP" : "BỊ CHẶN"} />
            <Info label="Giá Bid XAUUSD" value={price(telemetry?.quote?.bid ?? null)} />
            <Info label="Giá Ask XAUUSD" value={price(telemetry?.quote?.ask ?? null)} />
            <Info label="Số vị thế XAUUSD đang mở" value={String(telemetry?.positions.length ?? 0)} />
            <Info label="Thời điểm kiểm tra" value={telemetry?.checkedAt ? dateTime(telemetry.checkedAt) : "—"} />
          </Grid>
          <Typography variant="caption" color="text.secondary" display="block" mt={2}>
            {telemetry?.message ?? (mt5.error instanceof Error ? mt5.error.message : "Không đọc được dữ liệu MT5.")}
          </Typography>
        </CardContent>
      </Card>

      <Alert severity="info">Tài khoản thật luôn bị khóa trong chế độ chạy thử DEMO.</Alert>
    </Stack>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <Grid size={{ xs: 12, sm: 6, md: 4, xl: 3 }}>
      <Box className="mini-card" sx={{ height: "100%" }}>
        <Typography variant="caption" color="text.secondary">{label}</Typography>
        <Typography fontWeight={850} mt={0.5} sx={{ overflowWrap: "anywhere" }}>{value}</Typography>
      </Box>
    </Grid>
  );
}
