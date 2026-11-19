function requireMarker(source, marker, label) {
  if (!source.includes(marker)) {
    throw new Error(`Phase7C LIVE ${label} adapter marker no longer matches source; refusing LIVE execution.`);
  }
}

function normalizeSourceLineEndings(source) {
  return source.replace(/\r\n?/g, "\n");
}

const managedVolumeImport =
  'import { reconcileManagedVolume, remainingManagedPartialVolume } from "./phase7c-managed-volume-reconcile.mjs";\n';

function transformTrendManagedVolume(source) {
  source = normalizeSourceLineEndings(source);
  const mismatchMarker = `    if (Math.abs(managedPosition.volume - state.managed.expectedRemainingVolume) > spec.volumeStep / 2 + 1e-9) {
      journal("MANAGED_POSITION_VOLUME_MISMATCH", {
        ticket: managedPosition.ticket,
        expected: state.managed.expectedRemainingVolume,
        actual: managedPosition.volume,
      });
      return;
    }`;
  const partialMarker = "    const closeVolume = partialVolume(managed.initialVolume, position.volume, spec);";
  requireMarker(source, mismatchMarker, "Trend managed-volume");
  requireMarker(source, partialMarker, "Trend managed-volume partial");

  let output = source.replace(
    mismatchMarker,
    `    const reconciliation = reconcileManagedVolume(
      state.managed,
      managedPosition,
      spec,
      Number(quote.timestamp),
    );
    if (!reconciliation.accepted) {
      journal("MANAGED_POSITION_RECONCILIATION_BLOCK", {
        ticket: managedPosition.ticket,
        reason: reconciliation.reason,
        expectedVolume: reconciliation.expectedVolume ?? state.managed.expectedRemainingVolume,
        actualVolume: reconciliation.actualVolume ?? managedPosition.volume,
      });
      return;
    }
    if (reconciliation.events.length > 0) {
      state.managed = reconciliation.managed;
      saveState();
      for (const event of reconciliation.events) {
        const { type, ...details } = event;
        journal(type, { ticket: managedPosition.ticket, ...details });
      }
    }`,
  );
  output = output.replace(
    partialMarker,
    "    const closeVolume = remainingManagedPartialVolume(managed, position.volume, spec);",
  );
  return managedVolumeImport + output;
}

function transformSidewayManagedVolume(source) {
  source = normalizeSourceLineEndings(source);
  const reconciliationMarker =
    "    const reconciliation = reconcileManagedBrokerState(state.managed, managedPosition, spec);";
  const partialMarker = `    const closeVolume = oneThirdPartialVolume(
      managed.initialVolume,
      Number(position.volume),
      Number(spec.minVolume),
      Number(spec.volumeStep),
    );`;
  requireMarker(source, reconciliationMarker, "Sideway managed-volume");
  requireMarker(source, partialMarker, "Sideway managed-volume partial");

  let output = source.replace(
    reconciliationMarker,
    `    let reconciliation = reconcileManagedBrokerState(state.managed, managedPosition, spec);
    if (!reconciliation.accepted && reconciliation.reason === "MANAGED_VOLUME_MISMATCH") {
      reconciliation = reconcileManagedVolume(
        state.managed,
        managedPosition,
        spec,
        Number(quote.timestamp),
      );
    }`,
  );
  output = output.replace(
    partialMarker,
    "    const closeVolume = remainingManagedPartialVolume(managed, Number(position.volume), spec);",
  );
  return managedVolumeImport + output;
}

export function transformPhase7CTrendLegacySource(source) {
  const allowRealMarker = 'if (allowReal) throw new Error("Phase 7B DEMO refuses MT5_ALLOW_REAL_ACCOUNT=true.");';
  const modeMarker = 'health.accountMode !== "demo"';
  requireMarker(source, allowRealMarker, "Trend");
  requireMarker(source, modeMarker, "Trend");

  let output = source.replace(
    allowRealMarker,
    'if (!allowReal) throw new Error("Phase 7C LIVE Trend requires MT5_ALLOW_REAL_ACCOUNT=true.");',
  );
  output = output.replaceAll('health.accountMode !== "demo"', 'health.accountMode !== "real"');
  output = output.replaceAll('health.accountMode === "demo"', 'health.accountMode === "real"');
  output = output.replaceAll('requires accountMode=demo', 'requires accountMode=real');
  output = output.replaceAll('MT5 DEMO account login is unavailable.', 'MT5 LIVE account login is unavailable.');
  output = output.replaceAll('Add DEMO login', 'Add LIVE login');
  output = output.replaceAll('Current DEMO login', 'Current LIVE login');
  output = output.replaceAll('Demo state belongs to account', 'LIVE state belongs to account');
  output = output.replaceAll('Use the dedicated Phase 7B demo env', 'Use the dedicated Phase 7C LIVE env');
  return transformTrendManagedVolume(output);
}

export function transformPhase7CSidewaySource(source) {
  const allowRealMarker = 'if (allowReal) throw new Error("Phase 7C Sideway controller refuses MT5_ALLOW_REAL_ACCOUNT=true.");';
  const modeMarker = 'health.accountMode !== "demo"';
  requireMarker(source, allowRealMarker, "Sideway");
  requireMarker(source, modeMarker, "Sideway");

  let output = source.replace(
    allowRealMarker,
    'if (!allowReal) throw new Error("Phase 7C LIVE Sideway requires MT5_ALLOW_REAL_ACCOUNT=true.");',
  );
  output = output.replaceAll('health.accountMode !== "demo"', 'health.accountMode !== "real"');
  output = output.replaceAll('health.accountMode === "demo"', 'health.accountMode === "real"');
  output = output.replaceAll('requires accountMode=demo', 'requires accountMode=real');
  output = output.replaceAll('MT5 DEMO account login is unavailable.', 'MT5 LIVE account login is unavailable.');
  output = output.replaceAll('Add DEMO login', 'Add LIVE login');
  output = output.replaceAll('Current DEMO login', 'Current LIVE login');
  return transformSidewayManagedVolume(output);
}
