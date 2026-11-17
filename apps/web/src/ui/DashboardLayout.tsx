import { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  AppBar,
  Box,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  Toolbar,
  Typography,
} from "@mui/material";
import SmartToyRounded from "@mui/icons-material/SmartToyRounded";
import CandlestickChartRounded from "@mui/icons-material/CandlestickChartRounded";
import ScienceRounded from "@mui/icons-material/ScienceRounded";
import PowerSettingsNewRounded from "@mui/icons-material/PowerSettingsNewRounded";
import TuneRounded from "@mui/icons-material/TuneRounded";
import InsightsRounded from "@mui/icons-material/InsightsRounded";
import PhoneIphoneRounded from "@mui/icons-material/PhoneIphoneRounded";
import MenuRounded from "@mui/icons-material/MenuRounded";
import LockRounded from "@mui/icons-material/LockRounded";
import { useMt5Telemetry } from "../hooks";
import { StatusChip } from "./StatusChip";

const drawerWidth = 228;

type LinkRow = readonly [string, string, typeof SmartToyRounded];
type RuntimeLabel = "DEMO" | "LIVE" | "MT5 CHECK";

const links: readonly LinkRow[] = [
  ["/", "Bảng điều khiển", SmartToyRounded],
  ["/phase7b-pattern-check", "Tín hiệu & Mô hình", CandlestickChartRounded],
  ["/backtest", "Backtest & Đánh giá", ScienceRounded],
  ["/performance", "Hiệu suất & Đề xuất", InsightsRounded],
  ["/phase7b-ops", "Tài khoản & rủi ro", PowerSettingsNewRounded],
  ["/phase7c-control-center", "Trung tâm điều khiển", TuneRounded],
  ["/phase7c-mobile", "Điện thoại", PhoneIphoneRounded],
] as const;

function runtimeLabel(accountMode: string | undefined): RuntimeLabel {
  if (accountMode === "real") return "LIVE";
  if (accountMode === "demo") return "DEMO";
  return "MT5 CHECK";
}

function Navigation({ runtime, onNavigate }: { runtime: RuntimeLabel; onNavigate?: () => void }) {
  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column", p: 1.6 }}>
      <Stack direction="row" spacing={1.25} alignItems="center" sx={{ px: 0.8, py: 1.3 }}>
        <Box className="brand-mark">AU</Box>
        <Box>
          <Typography variant="caption" color="primary" sx={{ letterSpacing: ".18em" }}>XAUUSD</Typography>
          <Typography variant="subtitle2" fontWeight={900}>AI MASTER</Typography>
        </Box>
      </Stack>

      <Typography variant="caption" color="text.disabled" sx={{ px: 1.2, mt: 1.2, letterSpacing: ".12em", fontWeight: 800 }}>
        Vận hành {runtime}
      </Typography>
      <List dense sx={{ pt: 0.7 }}>
        {links.map(([href, label, Icon]) => (
          <ListItemButton
            key={href}
            component={NavLink}
            to={href}
            end={href === "/"}
            onClick={onNavigate}
            sx={{
              my: 0.35,
              px: 1.25,
              borderRadius: 2,
              color: "text.secondary",
              "&.active": {
                color: "text.primary",
                backgroundColor: "rgba(233,185,73,.09)",
                border: "1px solid rgba(233,185,73,.14)",
              },
            }}
          >
            <ListItemIcon sx={{ minWidth: 34, color: "inherit" }}><Icon fontSize="small" /></ListItemIcon>
            <ListItemText primary={label} primaryTypographyProps={{ fontSize: 13, fontWeight: 700 }} />
          </ListItemButton>
        ))}
      </List>

      <Box sx={{ mt: "auto", p: 1.6, borderRadius: 3, border: "1px solid rgba(148,163,184,.12)", bgcolor: "rgba(255,255,255,.02)" }}>
        <Stack direction="row" spacing={0.8} alignItems="center">
          <LockRounded fontSize="small" color="primary" />
          <Typography variant="caption" fontWeight={900}>MT5 PANEL · CHỈ ĐỌC</Typography>
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.9, lineHeight: 1.5 }}>
          Runtime hiện tại: {runtime}. Web không có quyền đặt lệnh. Chuyển DEMO/LIVE chỉ qua Guarded Account Switch với PAUSE + FLAT + xác nhận 2 bước; LIVE ARM vẫn là thao tác riêng.
        </Typography>
      </Box>
    </Box>
  );
}

export function DashboardLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const telemetry = useMt5Telemetry();
  const runtime = runtimeLabel(telemetry.data?.health?.accountMode);

  let headerTitle = `Bảng điều khiển vận hành ${runtime}`;
  let headerSubtitle = "XAUUSD · Giao diện tối ưu dễ nhìn · Mô hình hiện tại · Backtest · Hiệu suất & Rủi ro";
  if (location.pathname.startsWith("/phase7b-pattern-check")) {
    headerTitle = "Tín hiệu, Mô hình nến & Đề xuất chiến lược";
    headerSubtitle = `Nhận diện mô hình hiện tại · 12 Biểu đồ mẫu · Điều kiện vào lệnh · ${runtime}`;
  } else if (location.pathname.startsWith("/backtest")) {
    headerTitle = "Chế độ Backtest & Đánh giá hiệu suất Bot";
    headerSubtitle = `Kiểm thử lịch sử MT5 · So sánh Bot hiện tại vs 5 Đề xuất nâng cấp · Auto-Lot Shadow · ${runtime}`;
  } else if (location.pathname.startsWith("/phase7b-ops")) {
    headerTitle = "Tài khoản & rủi ro";
    headerSubtitle = `Tài khoản MT5 · khối lượng/rủi ro · an toàn · vận hành ${runtime}`;
  } else if (location.pathname.startsWith("/phase7c-control-center")) {
    headerTitle = "Trung tâm điều khiển";
    headerSubtitle = `MT5 · bot · Telegram · quyết định giao dịch · khối lượng/rủi ro · ${runtime}`;
  } else if (location.pathname.startsWith("/phase7c-mobile")) {
    headerTitle = "Điện thoại · chỉ đọc";
    headerSubtitle = `MOBILE_REMOTE_ACCESS_M1 · trạng thái canonical · ${runtime}`;
  } else if (location.pathname.startsWith("/performance")) {
    headerTitle = "Hiệu suất & Đề xuất tối ưu";
    headerSubtitle = `Kết quả giao dịch XAUUSD của tài khoản ${runtime} hiện tại · Phân rã theo Bot & Phiên`;
  }

  return (
    <Box sx={{ display: "flex", minHeight: "100vh" }}>
      <Drawer
        variant="permanent"
        sx={{
          width: drawerWidth,
          display: { xs: "none", lg: "block" },
          "& .MuiDrawer-paper": {
            width: drawerWidth,
            bgcolor: "#08111f",
            borderRightColor: "rgba(148,163,184,.12)",
          },
        }}
      >
        <Navigation runtime={runtime} />
      </Drawer>
      <Drawer
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        sx={{
          display: { xs: "block", lg: "none" },
          "& .MuiDrawer-paper": { width: drawerWidth, bgcolor: "#08111f" },
        }}
      >
        <Navigation runtime={runtime} onNavigate={() => setMobileOpen(false)} />
      </Drawer>

      <Box sx={{ flex: 1, minWidth: 0 }}>
        <AppBar
          position="sticky"
          elevation={0}
          sx={{
            bgcolor: "rgba(6,11,20,.88)",
            backdropFilter: "blur(14px)",
            borderBottom: "1px solid rgba(148,163,184,.10)",
          }}
        >
          <Toolbar sx={{ minHeight: { xs: 58, md: 62 } }}>
            <IconButton onClick={() => setMobileOpen(true)} sx={{ display: { lg: "none" }, mr: 1 }}><MenuRounded /></IconButton>
            <Box sx={{ flex: 1 }}>
              <Typography variant="subtitle2" fontWeight={900}>{headerTitle}</Typography>
              <Typography variant="caption" color="text.secondary">{headerSubtitle}</Typography>
            </Box>
            <StatusChip value={runtime} />
          </Toolbar>
        </AppBar>
        <Box component="main" sx={{ p: { xs: 1.5, md: 2.2 }, maxWidth: 1780, mx: "auto", width: "100%" }}>
          <Outlet />
        </Box>
      </Box>
    </Box>
  );
}
