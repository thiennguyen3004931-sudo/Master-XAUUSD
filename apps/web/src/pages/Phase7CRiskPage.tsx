import { useState } from "react";
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
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import {
  getPhase7BDemo,
  getPhase7CAccountRisk,
  getPhase7CAutoLotPreview,
} from "../api";
import { MetricCard } from "../ui/MetricCard";
import { ErrorState, LoadingState } from "../ui/PageState";

function money(value: number | null | undefined, currency = "USD") {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(Number(value));
}

export function Phase7CRiskPage() {
  const [riskPercent, setRiskPercent] = useState(0.25);
  const [maxLot, setMaxLot] = useState(0.03);
  const q = useQuery({
    queryKey: ["phase7c-risk", riskPercent, maxLot],
    queryFn: () => getPhase7CAccountRisk(riskPercent, maxLot),
    refetchInterval: 5000,
    retry: false,
  });
  const demo = useQuery({
    queryKey: ["phase7c-risk-current-signal"],
    queryFn: getPhase7BDemo,
    refetchInterval: 3000,
    retry: false,
  });
  const currentStopDistance = demo.data?.entryDiagnostics?.entry.stopDistance ?? null;
  const exact = useQuery({
    queryKey: ["phase7c-risk-exact", currentStopDistance, riskPercent, maxLot],
    queryFn: () =>
      getPhase7CAutoLotPreview(currentStopDistance ?? 0, riskPercent, maxLot),
    enabled: currentStopDistance !== null,
    refetchInterval: 5000,
    retry: false,
  });

  if (q.isLoading) return <LoadingState />;
  if (!q.data) {
    return (
      <ErrorState
        message={
          q.error instanceof Error
            ? q.error.message
            : "Không đọc được Risk & Auto Lot."
        }
      />
    );
  }

  const data = q.data;
  const currency = data.account.accountCurrency ?? "USD";

  return (
    <Stack spacing={2}>
      <Stack
        direction={{ xs: "column", md: "row" }}
        justifyContent="space-between"
        gap={2}
      >
        <Box>
          <Typography variant="overline" color="primary" fontWeight={800}>
            PHASE 7C · RISK
          </Typography>
          <Typography variant="h5" fontWeight={900}>
            Risk & Auto Lot Preview
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Endpoint này chỉ tính và hiển thị. Trend executor dùng fixed lot đang active; Sideway executor gọi cùng công thức sau final gate với đúng SL Supply/Demand + ATR + quote cuối.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          <Chip color="info" label="READ-ONLY PREVIEW" />
          <Chip variant="outlined" label="ORDER PERMISSION = NONE" />
        </Stack>
      </Stack>

      <Alert severity="info">
        Không Martingale, không tăng lot để gỡ lỗ. Nếu lot tối thiểu của broker vượt risk target thì hệ thống đề xuất <b>BLOCK</b>, không ép mở 0.01 lot.
      </Alert>

      <Card>
        <CardContent>
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <TextField
                fullWidth
                size="small"
                type="number"
                label="Risk target / trade (%)"
                value={riskPercent}
                onChange={(e) => setRiskPercent(Number(e.target.value))}
                slotProps={{ htmlInput: { min: 0.01, max: 5, step: 0.05 } }}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <TextField
                fullWidth
                size="small"
                type="number"
                label="Max Auto Lot cap"
                value={maxLot}
                onChange={(e) => setMaxLot(Number(e.target.value))}
                slotProps={{ htmlInput: { min: 0.01, step: 0.01 } }}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <MetricCard
                label="Target risk"
                value={money(data.configuration.targetRiskUsd, currency)}
                detail={`${data.configuration.riskPercent.toFixed(2)}% balance`}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <MetricCard
                label="Trend fixed active"
                value={`${data.configuration.currentFixedVolume.toFixed(2)} lot`}
                detail={data.configuration.lotSettingsRestartRequired
                  ? `Configured ${data.configuration.configuredTrendFixedLot.toFixed(2)} · cần restart`
                  : "Đang khớp cấu hình executor"}
              />
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Stack
            direction={{ xs: "column", md: "row" }}
            justifyContent="space-between"
            gap={2}
          >
            <Box>
              <Typography fontWeight={900}>Exact Auto Lot · Pattern hiện tại</Typography>
              <Typography variant="caption" color="text.secondary">
                Khi Pattern tạo được structural SL, hệ thống dùng đúng stopDistance canonical hiện tại thay vì làm tròn về 6/8/10.
              </Typography>
            </Box>
            <Chip color="info" variant="outlined" label="PREVIEW · NO ORDER CHANGE" />
          </Stack>

          {demo.isLoading ? (
            <LinearProgress sx={{ mt: 2 }} />
          ) : currentStopDistance === null ? (
            <Alert severity="info" sx={{ mt: 2 }}>
              Chưa có Pattern tạo structural SL. Exact Auto Lot sẽ xuất hiện ngay khi diagnostics có stopDistance; bảng 6/8/10 bên dưới vẫn dùng được để mô phỏng.
            </Alert>
          ) : exact.isLoading ? (
            <LinearProgress sx={{ mt: 2 }} />
          ) : exact.data ? (
            <Grid container spacing={2} sx={{ mt: 0.5 }}>
              <Grid size={{ xs: 12, sm: 6, xl: 3 }}>
                <MetricCard
                  label="Canonical SL"
                  value={`${exact.data.preview.stopDistance.toFixed(2)} giá`}
                  detail={`Loss 1.00 lot ${money(exact.data.preview.lossAtSlOneLot, currency)}`}
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, xl: 3 }}>
                <MetricCard
                  label="Raw lot"
                  value={exact.data.preview.rawLot.toFixed(4)}
                  detail={`Cap ${exact.data.configuration.maxLot.toFixed(2)} lot`}
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, xl: 3 }}>
                <MetricCard
                  label="Preview recommendation"
                  value={
                    exact.data.preview.approved
                      ? `${exact.data.preview.recommendedLot.toFixed(2)} lot`
                      : "BLOCK"
                  }
                  detail={`Broker step ${exact.data.broker.volumeStep}`}
                  tone={exact.data.preview.approved ? "success.main" : "error.main"}
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, xl: 3 }}>
                <MetricCard
                  label="Estimated risk"
                  value={money(exact.data.preview.estimatedRiskUsd, currency)}
                  detail={`${exact.data.preview.estimatedRiskPercent.toFixed(3)}% balance`}
                />
              </Grid>
              <Grid size={{ xs: 12 }}>
                <Alert severity={exact.data.preview.approved ? "success" : "warning"}>
                  {exact.data.preview.reason}
                </Alert>
              </Grid>
            </Grid>
          ) : (
            <Alert severity="warning" sx={{ mt: 2 }}>
              {exact.error instanceof Error
                ? exact.error.message
                : "Không tính được exact Auto Lot preview."}
            </Alert>
          )}
        </CardContent>
      </Card>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, sm: 6, xl: 3 }}>
          <MetricCard
            label="Account"
            value={String(data.account.accountLogin ?? "—")}
            detail={`${data.account.server ?? "—"} · ${String(data.account.accountMode ?? "—").toUpperCase()}`}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, xl: 3 }}>
          <MetricCard
            label="Balance / Equity"
            value={money(data.account.accountBalance, currency)}
            detail={money(data.account.accountEquity, currency)}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, xl: 3 }}>
          <MetricCard
            label="Leverage"
            value={`1:${data.account.accountLeverage ?? "—"}`}
            detail={`Free margin ${money(data.account.accountFreeMargin, currency)}`}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, xl: 3 }}>
          <MetricCard
            label="Spread"
            value={`${data.quote.spread.toFixed(2)} giá`}
            detail={`Guard ${data.spec.maxSpread.toFixed(2)} · ${data.quote.spread <= data.spec.maxSpread ? "PASS" : "BLOCK"}`}
            tone={data.quote.spread <= data.spec.maxSpread ? "success.main" : "error.main"}
          />
        </Grid>
      </Grid>

      <Card>
        <CardContent>
          <Typography fontWeight={900}>Auto Lot Shadow Matrix</Typography>
          <Typography variant="caption" color="text.secondary">
            Công thức dùng broker-native cash/price-unit/lot. Lot luôn floor theo volumeStep và clamp bởi Max Auto Lot cap.
          </Typography>
          <TableContainer sx={{ mt: 1 }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>SL distance</TableCell>
                  <TableCell align="right">Loss @ 1.00 lot</TableCell>
                  <TableCell align="right">Raw lot</TableCell>
                  <TableCell align="right">Recommended</TableCell>
                  <TableCell align="right">Risk $</TableCell>
                  <TableCell align="right">Risk %</TableCell>
                  <TableCell>Status</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.rows.map((row) => (
                  <TableRow key={row.stopDistance}>
                    <TableCell><b>{row.stopDistance.toFixed(0)} giá</b></TableCell>
                    <TableCell align="right">{money(row.lossAtSlOneLot, currency)}</TableCell>
                    <TableCell align="right">{row.rawLot.toFixed(4)}</TableCell>
                    <TableCell align="right"><b>{row.recommendedLot.toFixed(2)} lot</b></TableCell>
                    <TableCell align="right">{money(row.estimatedRiskUsd, currency)}</TableCell>
                    <TableCell align="right">{row.estimatedRiskPercent.toFixed(3)}%</TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        color={row.approved ? "success" : "error"}
                        variant="outlined"
                        label={row.approved ? "PREVIEW APPROVED" : "BLOCK"}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, xl: 6 }}>
          <Card sx={{ height: "100%" }}>
            <CardContent>
              <Typography fontWeight={900}>Broker / Symbol Specification</Typography>
              <Stack spacing={1} sx={{ mt: 2 }}>
                <Typography>Symbol: <b>{data.spec.brokerSymbol}</b></Typography>
                <Typography>Tick size: <b>{data.spec.tickSize}</b> · Point: <b>{data.spec.point}</b></Typography>
                <Typography>Cash / 1 giá / 1 lot: <b>${data.spec.cashPerPriceUnitPerLot.toFixed(2)}</b></Typography>
                <Typography>Contract size: <b>{data.spec.contractSize}</b></Typography>
                <Typography>Lot: min <b>{data.spec.minVolume}</b> · step <b>{data.spec.volumeStep}</b> · max <b>{data.spec.maxVolume}</b></Typography>
                <Typography>Stops level: <b>{(data.spec.stopsLevelTicks * data.spec.point).toFixed(2)} giá</b></Typography>
                <Typography variant="caption" color="text.secondary">
                  Risk value source: {data.spec.riskValueSource}
                </Typography>
              </Stack>
            </CardContent>
          </Card>
        </Grid>
        <Grid size={{ xs: 12, xl: 6 }}>
          <Card sx={{ height: "100%" }}>
            <CardContent>
              <Typography fontWeight={900}>Trading Permission</Typography>
              <Stack spacing={1.2} sx={{ mt: 2 }}>
                <Status label="Bridge trading" value={data.account.tradingEnabled} />
                <Status label="Terminal Algo Trading" value={data.account.terminalTradeAllowed} />
                <Status label="Expert trading" value={data.account.expertTradeAllowed} />
                <Status label="Account mode DEMO" value={data.account.accountMode === "demo"} />
                <Status label="Preview endpoint order permission" value={false} blockedText="NONE · READ-ONLY" />
                <Status label="Sideway final-gate sizing owner" value={true} />
              </Stack>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      <Alert severity="warning">
        Sideway chỉ dùng lot preview sau khi final gate hợp lệ và snapshot khớp account/symbol/SL/thời gian; Trend không dùng lot động. LIVE vẫn khóa.
      </Alert>
    </Stack>
  );
}

function Status({
  label,
  value,
  blockedText,
}: {
  label: string;
  value: boolean;
  blockedText?: string;
}) {
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="center">
      <Typography>{label}</Typography>
      <Chip
        size="small"
        color={value ? "success" : "warning"}
        variant="outlined"
        label={value ? "PASS" : blockedText ?? "OFF"}
      />
    </Stack>
  );
}
