export function phase7BForwardRuntimeDirName(
  brokerAccountMode: string | null | undefined,
): "phase7b-demo-forward" | "phase7b-live-forward" {
  return brokerAccountMode === "real"
    ? "phase7b-live-forward"
    : "phase7b-demo-forward";
}
