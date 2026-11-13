import { useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Grid,
  Stack,
  Typography,
} from "@mui/material";
import LockRounded from "@mui/icons-material/LockRounded";
import { useQueryClient } from "@tanstack/react-query";
import { setTradingMode } from "../api";
import { useDashboard } from "../hooks";
import { ErrorState, LoadingState } from "../ui/PageState";
import { StatusChip } from "../ui/StatusChip";

export function SettingsPage() {
  const query = useDashboard();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (query.isLoading) return <LoadingState />;
  if (!query.data) {
    return (
      <ErrorState message="Legacy control state hiện không khả dụng. Điều này không ảnh hưởng bot Phase 7B DEMO." />
    );
  }

  async function change(mode: "SHADOW" | "DEMO") {
    setSaving(true);
    setMessage(null);
    try {
      await setTradingMode(mode);
      await queryClient.invalidateQueries({ queryKey: ["dashboard-snapshot"] });
      setMessage(
        `Đã chuyển canonical research pipeline sang ${mode}. Thay đổi này KHÔNG ARM/DISARM Phase 7B DEMO.`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Không thể đổi legacy mode.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="overline" color="primary" fontWeight={800}>
          LEGACY RESEARCH CONTROL
        </Typography>
        <Typography variant="h5" fontWeight={800}>Cài đặt pipeline nghiên cứu</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          SHADOW/DEMO tại đây chỉ thuộc canonical dashboard cũ. Bot Phase 7B được ARM bằng script riêng và trạng thái thật phải xem ở trang Phase 7B Demo.
        </Typography>
      </Box>

      <Alert severity="warning">
        Không dùng trang này để bật hoặc tắt Phase 7B. `WAITING SIGNAL` / `MANAGING` trên trang Phase 7B Demo mới là trạng thái execution cần tin cậy.
      </Alert>

      <Stack direction="row" justifyContent="flex-end">
        <StatusChip value={query.data.control.mode} />
      </Stack>

      {message ? <Alert severity="info">{message}</Alert> : null}

      <Grid container spacing={2}>
        <Mode
          title="SHADOW"
          text="Canonical research pipeline phân tích nhưng không được coi là Phase 7B execution."
          active={query.data.control.mode === "SHADOW"}
          onClick={() => void change("SHADOW")}
          disabled={saving}
        />
        <Mode
          title="DEMO"
          text="Legacy demo control cho pipeline nghiên cứu; không tự khởi động controller Phase 7B."
          active={query.data.control.mode === "DEMO"}
          onClick={() => void change("DEMO")}
          disabled={saving}
        />
        <Grid size={{ xs: 12, md: 4 }}>
          <Card sx={{ height: "100%", opacity: .7 }}>
            <CardContent>
              <LockRounded color="primary" />
              <Typography fontWeight={800} sx={{ mt: 2 }}>LIVE LOCKED</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                Không có nút mở LIVE. Phase 7B hiện chỉ được phép chạy trên tài khoản MT5 DEMO đã allow-list.
              </Typography>
              <Button disabled fullWidth variant="outlined" sx={{ mt: 3 }}>
                Locked
              </Button>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Stack>
  );
}

function Mode({
  title,
  text,
  active,
  onClick,
  disabled,
}: {
  title: string;
  text: string;
  active: boolean;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <Grid size={{ xs: 12, md: 4 }}>
      <Card sx={{ height: "100%", borderColor: active ? "primary.main" : undefined }}>
        <CardContent>
          <Typography fontWeight={800}>{title}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1, minHeight: 64 }}>
            {text}
          </Typography>
          <Button
            onClick={onClick}
            disabled={disabled || active}
            fullWidth
            variant={active ? "contained" : "outlined"}
            sx={{ mt: 3 }}
          >
            {active ? "Đang sử dụng" : "Chuyển legacy mode"}
          </Button>
        </CardContent>
      </Card>
    </Grid>
  );
}
