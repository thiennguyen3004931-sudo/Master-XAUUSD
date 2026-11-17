function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) {
    throw new Error(`Phase7C M5 pre-structure profit-lock adapter could not find ${label}.`);
  }
  return source.replace(search, replacement);
}

function replaceAllRequired(source, search, replacement, label) {
  const count = source.split(search).length - 1;
  if (count < 1) {
    throw new Error(`Phase7C M5 pre-structure profit-lock adapter could not find ${label}.`);
  }
  return source.split(search).join(replacement);
}

function deferTrendHandoffUntilAcceptedM5Tighten(source) {
  source = replaceRequired(
    source,
    `  if (fastMoveStructure !== null && !managed.fastMoveHandedOffToM5) {
    managed.fastMoveHandedOffToM5 = true;
    saveState();
    journal("FAST_MOVE_HANDOFF_M5_STRUCTURE", {
      ticket: managed.ticket,
      side: managed.side,
      structurePrice: fastMoveStructure.price,
      pivotM5CloseTime: fastMoveStructure.pivotCloseTime,
      m5CloseTime: fastMoveStructure.confirmedAt,
    });
  }
  if (!managed.fastMoveHandedOffToM5) {
  if (fastMoveStructure === null) {
`,
    `  if (!managed.fastMoveHandedOffToM5) {
`,
    "Trend premature Fast-Move M5 handoff block",
  );

  source = replaceRequired(
    source,
    "  }\n  }\n  }\n\n  const hold =",
    "  }\n  }\n\n  const hold =",
    "Trend Fast-Move handoff guard closure",
  );

  source = replaceRequired(
    source,
    `      if (response.success) {
        managed.lastStructuralStop = m5Trail.stopLoss;
        saveState();
        journal("M5_STRUCTURAL_SL_TIGHTEN", {
`,
    `      if (response.success) {
        const handoffFromFastMove = !managed.fastMoveHandedOffToM5;
        managed.fastMoveHandedOffToM5 = true;
        managed.lastStructuralStop = m5Trail.stopLoss;
        if (handoffFromFastMove) {
          managed.fastMoveCycleAnchorPrice = exitPrice;
          managed.fastMovePeakPrice = exitPrice;
        }
        saveState();
        if (handoffFromFastMove) {
          journal("FAST_MOVE_HANDOFF_M5_STRUCTURE", {
            ticket: managed.ticket,
            side: managed.side,
            structurePrice: m5Trail.structurePrice,
            pivotM5CloseTime: m5Trail.pivotCloseTime,
            m5CloseTime: m5Trail.confirmedAt,
          });
        }
        journal("M5_STRUCTURAL_SL_TIGHTEN", {
`,
    "Trend successful M5 tighten handoff",
  );

  return source;
}

function addTrendCyclicOwnership(source) {
  source = replaceRequired(
    source,
    "  fastMoveHandedOffToM5?: boolean;\n",
    "  fastMoveHandedOffToM5?: boolean;\n  fastMoveCycleAnchorPrice?: number;\n  fastMoveCycleStartedAt?: number;\n",
    "Trend cyclic Fast-Move state fields",
  );

  source = replaceAllRequired(
    source,
    "afterTimestamp: managed.partialActivatedAt ?? managed.signalTimestamp,",
    "afterTimestamp: managed.fastMoveCycleStartedAt ?? managed.partialActivatedAt ?? managed.signalTimestamp,",
    "Trend M5 cycle structure boundary",
  );

  source = replaceRequired(
    source,
    `  if (!managed.fastMoveHandedOffToM5) {
`,
    `  if (managed.fastMoveHandedOffToM5 && !(Number(managed.fastMoveCycleAnchorPrice) > 0)) {
    managed.fastMoveCycleAnchorPrice = exitPrice;
    managed.fastMovePeakPrice = exitPrice;
    saveState();
    journal("FAST_MOVE_CYCLE_ANCHOR_MIGRATED", {
      ticket: managed.ticket,
      side: managed.side,
      anchorPrice: exitPrice,
      quoteTimestamp: Number(quote.timestamp),
    });
  }

  if (managed.fastMoveHandedOffToM5) {
    const fastMoveCycleAnchorPrice = Number(managed.fastMoveCycleAnchorPrice);
    const fastMoveReactivationDistance = managed.side === "BUY"
      ? exitPrice - fastMoveCycleAnchorPrice
      : fastMoveCycleAnchorPrice - exitPrice;
    if (
      fastMoveCycleAnchorPrice > 0 &&
      fastMoveReactivationDistance + 1e-9 >= FAST_MOVE_PROFIT_LOCK_ACTIVATION_PRICE
    ) {
      managed.fastMoveHandedOffToM5 = false;
      managed.fastMoveCycleStartedAt = Number(quote.timestamp);
      managed.fastMovePeakPrice = exitPrice;
      saveState();
      journal("FAST_MOVE_REACTIVATED_AFTER_M5", {
        ticket: managed.ticket,
        side: managed.side,
        anchorPrice: fastMoveCycleAnchorPrice,
        marketPrice: exitPrice,
        favorableFromAnchor: fastMoveReactivationDistance,
        cycleStartedAt: managed.fastMoveCycleStartedAt,
      });
    }
  }

  if (!managed.fastMoveHandedOffToM5) {
`,
    "Trend cyclic Fast-Move reactivation gate",
  );

  source = replaceRequired(
    source,
    `  const fastMove = fastMoveProfitLockCandidate({
    side: managed.side,
    entry: position.entry,
`,
    `  const fastMoveReferencePrice = Number(managed.fastMoveCycleAnchorPrice) > 0
    ? Number(managed.fastMoveCycleAnchorPrice)
    : Number(position.entry);
  const fastMove = fastMoveProfitLockCandidate({
    side: managed.side,
    entry: fastMoveReferencePrice,
`,
    "Trend Fast-Move cycle reference price",
  );

  return source;
}

function deferSidewayHandoffUntilAcceptedM5Tighten(source) {
  source = replaceRequired(
    source,
    `  if (fastMoveStructure !== null && !managed.fastMoveHandedOffToM5) {
    managed.fastMoveHandedOffToM5 = true;
    saveState();
    journal("FAST_MOVE_HANDOFF_M5_STRUCTURE", {
      ticket: managed.ticket,
      side: managed.side,
      structurePrice: fastMoveStructure.price,
      pivotM5CloseTime: fastMoveStructure.pivotCloseTime,
      m5CloseTime: fastMoveStructure.confirmedAt,
    });
  }
  if (!managed.fastMoveHandedOffToM5) {
  if (fastMoveStructure === null) {
`,
    `  if (!managed.fastMoveHandedOffToM5) {
`,
    "Sideway premature Fast-Move M5 handoff block",
  );

  const legacyCloseAnchor =
    "  }\n  }\n  }\n\n  if (managed.breakEvenApplied && !managed.partialApplied && targetReached(managed.side, marketPrice, managed.tp1)) {";
  const brokerOnlyCloseAnchor =
    "  }\n  }\n  }\n\n  // A native broker TP/SL is authoritative after entry; never even evaluate a";
  const closeAnchor = source.includes(brokerOnlyCloseAnchor) ? brokerOnlyCloseAnchor : legacyCloseAnchor;
  source = replaceRequired(
    source,
    closeAnchor,
    closeAnchor.replace("  }\n  }\n  }\n\n", "  }\n  }\n\n"),
    "Sideway Fast-Move handoff guard closure",
  );

  source = replaceRequired(
    source,
    `          if (response.success) {
            managed.lastStructuralStop = m5Trail.stopLoss;
            saveState();
            journal("SIDEWAY_M5_STRUCTURAL_SL_TIGHTEN", {
`,
    `          if (response.success) {
            const handoffFromFastMove = !managed.fastMoveHandedOffToM5;
            managed.fastMoveHandedOffToM5 = true;
            managed.lastStructuralStop = m5Trail.stopLoss;
            if (handoffFromFastMove) {
              managed.fastMoveCycleAnchorPrice = marketPrice;
              managed.fastMovePeakPrice = marketPrice;
            }
            saveState();
            if (handoffFromFastMove) {
              journal("FAST_MOVE_HANDOFF_M5_STRUCTURE", {
                ticket: managed.ticket,
                side: managed.side,
                structurePrice: m5Trail.structurePrice,
                pivotM5CloseTime: m5Trail.pivotCloseTime,
                m5CloseTime: m5Trail.confirmedAt,
              });
            }
            journal("SIDEWAY_M5_STRUCTURAL_SL_TIGHTEN", {
`,
    "Sideway successful M5 tighten handoff",
  );

  return source;
}

function addSidewayCyclicOwnership(source) {
  source = replaceRequired(
    source,
    "    fastMoveHandedOffToM5: false,\n",
    "    fastMoveHandedOffToM5: false,\n    fastMoveCycleAnchorPrice: null,\n    fastMoveCycleStartedAt: null,\n",
    "Sideway cyclic Fast-Move state fields",
  );

  source = replaceAllRequired(
    source,
    "afterTimestamp: Number(managed.partialActivatedAt ?? managed.signalM5CloseTime ?? 0),",
    "afterTimestamp: Number(managed.fastMoveCycleStartedAt ?? managed.partialActivatedAt ?? managed.signalM5CloseTime ?? 0),",
    "Sideway M5 cycle structure boundary",
  );

  source = replaceRequired(
    source,
    `  if (!managed.fastMoveHandedOffToM5) {
`,
    `  if (managed.fastMoveHandedOffToM5 && !(Number(managed.fastMoveCycleAnchorPrice) > 0)) {
    managed.fastMoveCycleAnchorPrice = marketPrice;
    managed.fastMovePeakPrice = marketPrice;
    saveState();
    journal("FAST_MOVE_CYCLE_ANCHOR_MIGRATED", {
      ticket: managed.ticket,
      side: managed.side,
      anchorPrice: marketPrice,
      quoteTimestamp: Number(quote.timestamp),
    });
  }

  if (managed.fastMoveHandedOffToM5) {
    const fastMoveCycleAnchorPrice = Number(managed.fastMoveCycleAnchorPrice);
    const fastMoveReactivationDistance = managed.side === "BUY"
      ? marketPrice - fastMoveCycleAnchorPrice
      : fastMoveCycleAnchorPrice - marketPrice;
    if (
      fastMoveCycleAnchorPrice > 0 &&
      fastMoveReactivationDistance + 1e-9 >= FAST_MOVE_PROFIT_LOCK_ACTIVATION_PRICE
    ) {
      managed.fastMoveHandedOffToM5 = false;
      managed.fastMoveCycleStartedAt = Number(quote.timestamp);
      managed.fastMovePeakPrice = marketPrice;
      saveState();
      journal("FAST_MOVE_REACTIVATED_AFTER_M5", {
        ticket: managed.ticket,
        side: managed.side,
        anchorPrice: fastMoveCycleAnchorPrice,
        marketPrice,
        favorableFromAnchor: fastMoveReactivationDistance,
        cycleStartedAt: managed.fastMoveCycleStartedAt,
      });
    }
  }

  if (!managed.fastMoveHandedOffToM5) {
`,
    "Sideway cyclic Fast-Move reactivation gate",
  );

  source = replaceRequired(
    source,
    `  const fastMove = fastMoveProfitLockCandidate({
    side: managed.side,
    entry: managed.entry,
`,
    `  const fastMoveReferencePrice = Number(managed.fastMoveCycleAnchorPrice) > 0
    ? Number(managed.fastMoveCycleAnchorPrice)
    : Number(managed.entry);
  const fastMove = fastMoveProfitLockCandidate({
    side: managed.side,
    entry: fastMoveReferencePrice,
`,
    "Sideway Fast-Move cycle reference price",
  );

  return source;
}

export function transformPhase7CTrendM5PreStructureProfitLockSource(input) {
  let source = String(input);

  source = deferTrendHandoffUntilAcceptedM5Tighten(source);
  source = addTrendCyclicOwnership(source);
  source = replaceRequired(
    source,
    "  const fastMove = fastMoveProfitLockCandidate({",
    `  const fastMoveEligible = stopIsAtLeastAsTight(
    managed.side,
    Number(position.stopLoss),
    Number(position.entry),
  );
  const fastMove = fastMoveProfitLockCandidate({`,
    "Trend Fast-Move eligibility insertion point",
  );
  source = replaceRequired(
    source,
    "  if (fastMove.active) {",
    "  if (fastMove.active && fastMoveEligible) {",
    "Trend Fast-Move mutation gate",
  );

  return source;
}

export function transformPhase7CSidewayM5PreStructureProfitLockSource(input) {
  let source = String(input);

  source = deferSidewayHandoffUntilAcceptedM5Tighten(source);
  source = addSidewayCyclicOwnership(source);
  source = replaceRequired(
    source,
    "  const fastMove = fastMoveProfitLockCandidate({",
    `  const fastMoveEligible = stopIsAtLeastAsTight(
    managed.side,
    Number(position.stopLoss),
    Number(managed.entry),
  );
  const fastMove = fastMoveProfitLockCandidate({`,
    "Sideway Fast-Move eligibility insertion point",
  );
  source = replaceRequired(
    source,
    "  if (fastMove.active) {",
    "  if (fastMove.active && fastMoveEligible) {",
    "Sideway Fast-Move mutation gate",
  );

  return source;
}
