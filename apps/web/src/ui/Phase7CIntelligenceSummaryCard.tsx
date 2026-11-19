import { useQuery } from "@tanstack/react-query";
import { Link as RouterLink } from "react-router-dom";
import { Box, Button, Card, CardContent, Chip, Stack, Typography } from "@mui/material";
import { getPhase7CPerformanceIntelligence } from "../phase7c-performance-intelligence-api";

export function Phase7CIntelligenceSummaryCard() {
  const query = useQuery({
    queryKey: ["phase7c-performance-intelligence", 90, "XAUUSD"],
    queryFn: () => getPhase7CPerformanceIntelligence(90, "XAUUSD"),
    refetchInterval: 15_000,
    retry: false,
  });

  const snapshot = query.data;
  const coverage = snapshot?.coverage.correlationCoveragePercent ?? null;
  const exact = snapshot?.coverage.exactTrades ?? null;
  const ambiguous = snapshot?.coverage.ambiguousTrades ?? null;
  const unmatched = snapshot?.coverage.unmatchedTrades ?? null;
  const complete = snapshot ? ambiguous === 0 && unmatched === 0 : false;

  return (
    <Card variant="outlined" sx={{ borderRadius: 3 }}>
      <CardContent sx={{ py: 1.6, px: { xs: 1.7, md: 2 }, "&:last-child": { pb: 1.6 } }}>
        <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" alignItems={{ md: "center" }} gap={1.2}>
          <Box>
            <Stack direction="row" spacing={0.8} useFlexGap flexWrap="wrap" alignItems="center">
              <Typography fontWeight={950}>Intelligence & hiệu suất</Typography>
              <Chip size="small" label="READ ONLY" variant="outlined" />
              {snapshot ? (
                <Chip
                  size="small"
                  label={complete ? "ATTRIBUTION OK" : "CẦN RÀ SOÁT"}
                  color={complete ? "success" : "warning"}
                  variant="outlined"
                />
              ) : null}
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.45 }}>
              Control Center chỉ giữ summary vận hành; phân tích rule, effectiveness, counterfactual và recommendation xem tại trang Hiệu suất.
            </Typography>
          </Box>

          <Stack direction={{ xs: "column", sm: "row" }} spacing={0.8} alignItems={{ sm: "center" }}>
            <Stack direction="row" spacing={0.6} useFlexGap flexWrap="wrap">
              <Chip size="small" label={`COVERAGE ${coverage === null ? "—" : `${coverage.toFixed(1)}%`}`} variant="outlined" />
              <Chip size="small" label={`EXACT ${exact ?? "—"}`} variant="outlined" />
              <Chip size="small" label={`AMB ${ambiguous ?? "—"}`} variant="outlined" />
              <Chip size="small" label={`UNMATCHED ${unmatched ?? "—"}`} variant="outlined" />
            </Stack>
            <Button component={RouterLink} to="/performance" size="small" variant="outlined" sx={{ fontWeight: 900, whiteSpace: "nowrap" }}>
              Mở Hiệu suất
            </Button>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}
