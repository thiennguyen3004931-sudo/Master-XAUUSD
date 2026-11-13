export interface Phase7BEntryDiagnosticsAccountContext {
  reachable: boolean;
  accountMode: string | null | undefined;
}

export function shouldComputePhase7BEntryDiagnostics(
  context: Phase7BEntryDiagnosticsAccountContext,
): boolean {
  if (!context.reachable) return false;
  return context.accountMode === "demo" || context.accountMode === "real";
}
