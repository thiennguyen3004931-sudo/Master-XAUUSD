import { useQuery } from "@tanstack/react-query";
import { getDashboard, getMt5Performance, getMt5Telemetry } from "./api";

export function useDashboard(enabled = true) {
  return useQuery({
    queryKey: ["dashboard-snapshot"],
    queryFn: getDashboard,
    refetchInterval: enabled ? 5_000 : false,
    enabled,
  });
}

export function useMt5Telemetry(symbol = "XAUUSD") {
  return useQuery({
    queryKey: ["mt5-telemetry", symbol],
    queryFn: () => getMt5Telemetry(symbol),
    refetchInterval: 3_000,
    retry: false,
  });
}

export function useMt5Performance(days = 90) {
  return useQuery({
    queryKey: ["mt5-performance", days],
    queryFn: () => getMt5Performance(days),
    refetchInterval: 15_000,
    retry: false,
  });
}
