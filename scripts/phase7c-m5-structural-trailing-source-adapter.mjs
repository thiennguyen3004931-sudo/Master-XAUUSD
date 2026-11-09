function normalizeNewlines(source) {
  return String(source).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) {
    throw new Error(`Phase7C M5 structural trailing adapter could not find ${label}.`);
  }
  return source.replace(search, replacement);
}

function replaceOneOfRequired(source, searches, replacement, label) {
  const matches = searches.filter((search) => source.includes(search));
  if (matches.length !== 1) {
    throw new Error(
      `Phase7C M5 structural trailing adapter expected exactly one ${label}, found ${matches.length}.`,
    );
  }
  return source.replace(matches[0], replacement);
}

function prependImport(source) {
  const importLine = 'import { evaluateM5StructuralTrail, latestConfirmedM5Structure } from "./phase7c-m5-structural-trailing.mjs";\n';
  const legacyImportLine = 'import { evaluateM5StructuralTrail } from "./phase7c-m5-structural-trailing.mjs";\n';
  if (source.includes(importLine.trim())) return source;
  if (source.includes(legacyImportLine.trim())) {
    return source.replace(legacyImportLine, importLine);
  }
  return importLine + source;
}

export function transformPhase7CTrendM5TrailingSource(input) {
  let source = prependImport(normalizeNewlines(input));

  source = replaceRequired(
    source,
    'console.log("PHASE7B_DEMO_RUNNER_SL=M15_CONFIRMED_STRUCTURE_TRAILING");',
    'console.log("PHASE7B_DEMO_RUNNER_SL=M5_CONFIRMED_STRUCTURE_TRAILING");',
    "Trend runner trailing declaration",
  );
  source = replaceRequired(
    source,
    'console.log("PHASE7B_DEMO_POST_PLUS10_SL=M15_CONFIRMED_SWING_STRUCTURE_PLUS_1_BUFFER_ONLY_TIGHTEN");',
    'console.log("PHASE7B_DEMO_POST_PLUS10_SL=M5_CONFIRMED_SWING_STRUCTURE_PLUS_1_BUFFER_ONLY_TIGHTEN");',
    "Trend post +10 trailing declaration",
  );

  source = replaceRequired(
    source,
    "  fastMoveAttempt?: number;\n",
    "  fastMoveAttempt?: number;\n  fastMoveHandedOffToM5?: boolean;\n",
    "Trend durable Fast-Move M5 handoff state",
  );
  source = replaceRequired(
    source,
    "    await managePosition(managedPosition, quote, spec, m15);",
    "    await managePosition(managedPosition, quote, spec, m15, m5);",
    "Trend managed-position M5 handoff",
  );
  source = replaceRequired(
    source,
    "    await managePosition(\n      candidate,\n      quote,\n      spec,\n      m15,\n    );",
    "    await managePosition(\n      candidate,\n      quote,\n      spec,\n      m15,\n      m5,\n    );",
    "Trend recovered-position M5 handoff",
  );
  source = replaceRequired(
    source,
    "async function managePosition(position: Position, quote: Quote, spec: SymbolSpec, m15: Phase7Bar[]): Promise<void> {",
    "async function managePosition(position: Position, quote: Quote, spec: SymbolSpec, m15: Phase7Bar[], m5: Phase7Bar[]): Promise<void> {",
    "Trend management signature",
  );
  source = replaceRequired(
    source,
    "  const latestM15 = m15.at(-1);\n  const holdM15CloseTime = Number(latestM15?.closeTime ?? 0);",
    "  const latestM15 = m15.at(-1);\n  const latestM5 = m5.at(-1);\n  const holdM15CloseTime = Number(latestM15?.closeTime ?? 0);",
    "Trend latest M5 snapshot",
  );

  source = replaceRequired(
    source,
    `  const fastMoveStructure = managed.partialApplied && latestM15
    ? latestConfirmedStructureStop(managed.side, m15, managed.signalTimestamp, latestM15.closeTime)
    : null;
  if (fastMoveStructure === null) {
`,
    `  const fastMoveStructure = managed.partialApplied && latestM5
    ? latestConfirmedM5Structure({
        side: managed.side,
        bars: m5,
        afterTimestamp: managed.partialActivatedAt ?? managed.signalTimestamp,
        atOrBefore: latestM5.closeTime,
      })
    : null;
  if (fastMoveStructure !== null && !managed.fastMoveHandedOffToM5) {
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
    "Trend Fast-Move M5 ownership handoff",
  );
  source = replaceRequired(
    source,
    "  }\n  }\n\n  const hold =",
    "  }\n  }\n  }\n\n  const hold =",
    "Trend durable Fast-Move M5 handoff guard",
  );

  const oldTrailing = `    const structure = latestConfirmedStructureStop(managed.side, m15, managed.signalTimestamp, latest.closeTime);
    if (structure !== null) {
      const candidate = roundPrice(
        structuralStopWithBuffer(managed.side, structure),
        spec.digits,
      );
      const structuralBaseline = tightestKnownStop(
        managed.side,
        Number(position.stopLoss),
        Number(managed.lastStructuralStop),
      );
      if (stopStrictlyTightens(managed.side, structuralBaseline, candidate)) {
        const minimumGap = Math.max(spec.stopsLevelTicks, spec.freezeLevelTicks) * spec.point;
        const validAgainstMarket = managed.side === "BUY"
          ? candidate < quote.bid - minimumGap
          : candidate > quote.ask + minimumGap;
        if (validAgainstMarket) {
          managed.structureAttempt += 1;
          saveState();
          const commandId = \`p7b-struct-\${managed.ticket}-\${latest.closeTime}-\${managed.structureAttempt}\`;
          const response = await patch<CommandResponse>(\`/v1/positions/\${encodeURIComponent(managed.ticket)}\`, {
            stopLoss: candidate,
            commandId,
          });
          if (response.success) {
            managed.lastStructuralStop = candidate;
            saveState();
            journal("STRUCTURAL_SL_TIGHTEN", { ticket: managed.ticket, stopLoss: candidate, m15CloseTime: latest.closeTime, response });
          } else {
            journal("STRUCTURAL_SL_REJECTED", { ticket: managed.ticket, stopLoss: candidate, response });
          }
        }
      }
    }
`;

  const newTrailing = `    const m5Trail = latestM5
      ? evaluateM5StructuralTrail({
          side: managed.side,
          bars: m5,
          afterTimestamp: managed.partialActivatedAt ?? managed.signalTimestamp,
          atOrBefore: latestM5.closeTime,
          currentStop: Number(position.stopLoss),
          lastStructuralStop: Number(managed.lastStructuralStop),
          bid: quote.bid,
          ask: quote.ask,
          digits: spec.digits,
          point: spec.point,
          stopsLevelTicks: spec.stopsLevelTicks,
          freezeLevelTicks: spec.freezeLevelTicks,
        })
      : { allowed: false, reason: "M5_DATA_MISSING" };

    if (m5Trail.allowed) {
      managed.structureAttempt += 1;
      saveState();
      const commandId = \`p7b-m5-struct-\${managed.ticket}-\${m5Trail.confirmedAt}-\${managed.structureAttempt}\`;
      const response = await patch<CommandResponse>(\`/v1/positions/\${encodeURIComponent(managed.ticket)}\`, {
        stopLoss: m5Trail.stopLoss,
        commandId,
      });
      if (response.success) {
        managed.lastStructuralStop = m5Trail.stopLoss;
        saveState();
        journal("M5_STRUCTURAL_SL_TIGHTEN", {
          ticket: managed.ticket,
          previousStopLoss: position.stopLoss,
          stopLoss: m5Trail.stopLoss,
          structurePrice: m5Trail.structurePrice,
          pivotM5CloseTime: m5Trail.pivotCloseTime,
          m5CloseTime: m5Trail.confirmedAt,
          response,
        });
      } else {
        journal("M5_STRUCTURAL_SL_REJECTED", { ticket: managed.ticket, stopLoss: m5Trail.stopLoss, response });
      }
    }
`;
  source = replaceRequired(source, oldTrailing, newTrailing, "Trend M15 structural trailing block");

  return source;
}

export function transformPhase7CSidewayM5TrailingSource(input) {
  let source = prependImport(normalizeNewlines(input));

  const brokerOnlyDeclaration =
    'console.log("PHASE7C_SIDEWAY_MANAGEMENT=BROKER_TP_SL_PLUS_MONOTONIC_STOP_TIGHTENING");';
  if (source.includes(brokerOnlyDeclaration)) {
    source = replaceRequired(
      source,
      brokerOnlyDeclaration,
      'console.log("PHASE7C_SIDEWAY_MANAGEMENT=BROKER_TP_SL_PLUS_MONOTONIC_STOP_TIGHTENING_PLUS_M5_STRUCTURE");',
      "Sideway broker-only management declaration",
    );
  } else {
    source = replaceOneOfRequired(
      source,
      [
        'console.log("PHASE7C_SIDEWAY_MANAGEMENT=PLUS6_BREAK_EVEN_PLUS10_ONE_THIRD_NO_TRAILING");',
        'console.log("PHASE7C_SIDEWAY_MANAGEMENT=PLUS6_BREAK_EVEN_PLUS10_ONE_THIRD_PLUS_FAST_MOVE_LOCK");',
      ],
      'console.log("PHASE7C_SIDEWAY_MANAGEMENT=PLUS6_BREAK_EVEN_PLUS10_ONE_THIRD_M5_CONFIRMED_STRUCTURE_TRAILING");',
      "Sideway management declaration",
    );
  }

  source = replaceRequired(
    source,
    "    partialApplied: false,\n    breakEvenApplied: false,",
    "    partialApplied: false,\n    partialActivatedAt: null,\n    breakEvenApplied: false,\n    lastStructuralStop: Number(opened.stopLoss || pending.stopLoss),\n    structureAttempt: 0,\n    fastMoveHandedOffToM5: false,",
    "Sideway managed trailing state",
  );

  source = replaceRequired(
    source,
    "      managed.breakEvenApplied = true;\n      saveState();\n      journal(\"PLUS6_SL_ALREADY_AT_OR_TIGHTER\"",
    "      managed.breakEvenApplied = true;\n      managed.lastStructuralStop = Number(position.stopLoss);\n      saveState();\n      journal(\"PLUS6_SL_ALREADY_AT_OR_TIGHTER\"",
    "Sideway already-tight BE state",
  );
  source = replaceRequired(
    source,
    "          managed.breakEvenApplied = true;\n          saveState();\n          journal(\"PLUS6_SL_TO_ENTRY\"",
    "          managed.breakEvenApplied = true;\n          managed.lastStructuralStop = beStop;\n          saveState();\n          journal(\"PLUS6_SL_TO_ENTRY\"",
    "Sideway BE success state",
  );
  source = replaceRequired(
    source,
    "        managed.partialApplied = true;\n        managed.expectedRemainingVolume = normalizeVolume(Number(position.volume) - closeVolume, Number(spec.volumeStep));",
    "        managed.partialApplied = true;\n        managed.partialActivatedAt = Number(quote.timestamp);\n        managed.expectedRemainingVolume = normalizeVolume(Number(position.volume) - closeVolume, Number(spec.volumeStep));",
    "Sideway partial activation timestamp",
  );

  const fastMoveHandoffPrefix = `  let sidewayM5ManagementSnapshot = null;
  let sidewayM5ManagementLoadAttempted = false;
  const loadSidewayM5ManagementSnapshot = async () => {
    if (sidewayM5ManagementLoadAttempted) return sidewayM5ManagementSnapshot;
    sidewayM5ManagementLoadAttempted = true;
    try {
      const bars = await bridgeGet(\`/v1/candles/\${encodeURIComponent(symbol)}?timeframe=M5&count=\${m5CandleCount}\`);
      const latest = Array.isArray(bars) ? bars.at(-1) : null;
      const closeTime = Number(latest?.closeTime ?? 0);
      const freshness = evaluateTimestampFreshness(closeTime, {
        maxAgeMs: maxM5AgeMs,
        clockOffsetMs: brokerClockOffsetMs,
      });
      sidewayM5ManagementSnapshot = {
        bars: Array.isArray(bars) ? bars : [],
        latest,
        closeTime,
        freshness,
        error: null,
      };
    } catch (error) {
      sidewayM5ManagementSnapshot = {
        bars: [],
        latest: null,
        closeTime: 0,
        freshness: { fresh: false, reason: "M5_TRAILING_DATA_OR_BROKER_ERROR" },
        error: errorMessage(error),
      };
    }
    return sidewayM5ManagementSnapshot;
  };

  const fastMoveStructure = managed.partialApplied || (typeof brokerTpSlTrailOnly !== "undefined" && brokerTpSlTrailOnly)
    ? await (async () => {
        const snapshot = await loadSidewayM5ManagementSnapshot();
        if (!snapshot?.latest || !snapshot.freshness?.fresh) return null;
        return latestConfirmedM5Structure({
          side: managed.side,
          bars: snapshot.bars,
          afterTimestamp: Number(managed.partialActivatedAt ?? managed.signalM5CloseTime ?? 0),
          atOrBefore: snapshot.closeTime,
        });
      })()
    : null;
  if (fastMoveStructure !== null && !managed.fastMoveHandedOffToM5) {
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
`;
  source = replaceRequired(
    source,
    "  const fastMove = fastMoveProfitLockCandidate({",
    `${fastMoveHandoffPrefix}  const fastMove = fastMoveProfitLockCandidate({`,
    "Sideway Fast-Move M5 ownership handoff",
  );
  // The legacy strategy closed 1/3 at TP1, but the broker-only contract
  // short-circuits that entire branch. Preserve both source layouts so the
  // M5 Fast-Move ownership handoff is never lost after this strategy update.
  const legacyHandoffAnchor =
    "  }\n\n  if (managed.breakEvenApplied && !managed.partialApplied && targetReached(managed.side, marketPrice, managed.tp1)) {";
  const brokerOnlyHandoffAnchor =
    "  }\n\n  // A native broker TP/SL is authoritative after entry; never even evaluate a";
  const handoffAnchor = source.includes(brokerOnlyHandoffAnchor) ? brokerOnlyHandoffAnchor : legacyHandoffAnchor;
  source = replaceRequired(
    source,
    handoffAnchor,
    handoffAnchor.replace("  }\n\n", "  }\n  }\n  }\n\n"),
    "Sideway durable Fast-Move M5 handoff guard",
  );

  const trailingInsertion = `
  if (managed.partialApplied || (typeof brokerTpSlTrailOnly !== "undefined" && brokerTpSlTrailOnly)) {
    try {
      const snapshot = await loadSidewayM5ManagementSnapshot();
      const latestM5 = snapshot?.latest ?? null;
      const m5CloseTime = Number(snapshot?.closeTime ?? 0);
      const m5Freshness = snapshot?.freshness ?? { fresh: false, reason: "M5_DATA_MISSING" };

      if (!latestM5 || !m5Freshness.fresh) {
        journal("SIDEWAY_M5_STRUCTURAL_SL_SKIP", {
          ticket: managed.ticket,
          reason: snapshot?.error ? "M5_TRAILING_DATA_OR_BROKER_ERROR" : latestM5 ? m5Freshness.reason : "M5_DATA_MISSING",
          m5CloseTime: m5CloseTime || null,
          message: snapshot?.error ?? undefined,
        });
      } else {
        const m5Trail = evaluateM5StructuralTrail({
          side: managed.side,
          bars: snapshot.bars,
          afterTimestamp: Number(managed.partialActivatedAt ?? managed.signalM5CloseTime ?? 0),
          atOrBefore: m5CloseTime,
          currentStop: Number(position.stopLoss),
          lastStructuralStop: tightestKnownStop(
            managed.side,
            Number(managed.lastStructuralStop ?? 0),
            Number(managed.fastMoveStop ?? 0),
            // The broker position snapshot can be stale in the SAME cycle
            // after +6 BE PATCH succeeds. Include the newly accepted BE
            // floor so M5 must not undo a stricter SL before next poll.
            managed.breakEvenApplied ? Number(managed.entry) : 0,
          ),
          bid: quote.bid,
          ask: quote.ask,
          digits: Number(spec.digits ?? 2),
          point: Number(spec.point),
          stopsLevelTicks: Number(spec.stopsLevelTicks ?? 0),
          freezeLevelTicks: Number(spec.freezeLevelTicks ?? 0),
        });

        if (m5Trail.allowed) {
          managed.structureAttempt = Number(managed.structureAttempt ?? 0) + 1;
          saveState();
          const response = await bridgeRequest("PATCH", \`/v1/positions/\${encodeURIComponent(managed.ticket)}\`, {
            stopLoss: m5Trail.stopLoss,
            commandId: \`p7c-sideway-m5-struct-\${managed.ticket}-\${m5Trail.confirmedAt}-\${managed.structureAttempt}\`,
          });
          if (response.success) {
            managed.lastStructuralStop = m5Trail.stopLoss;
            saveState();
            journal("SIDEWAY_M5_STRUCTURAL_SL_TIGHTEN", {
              ticket: managed.ticket,
              previousStopLoss: position.stopLoss,
              stopLoss: m5Trail.stopLoss,
              structurePrice: m5Trail.structurePrice,
              pivotM5CloseTime: m5Trail.pivotCloseTime,
              m5CloseTime: m5Trail.confirmedAt,
              response,
            });
          } else {
            journal("SIDEWAY_M5_STRUCTURAL_SL_REJECTED", {
              ticket: managed.ticket,
              stopLoss: m5Trail.stopLoss,
              response,
            });
          }
        }
      }
    } catch (error) {
      journal("SIDEWAY_M5_STRUCTURAL_SL_SKIP", {
        ticket: managed.ticket,
        reason: "M5_TRAILING_DATA_OR_BROKER_ERROR",
        message: errorMessage(error),
      });
    }
  }
`;

  const brokerOnlyInsertionMarker =
    "\n  // TP/SL are broker-native; never close at a secondary target, regime change,";
  const legacyInsertionMarker =
    "\n  if (await closeFixedTpIfTriggered(position, quote)) return;\n\n  // TP2 is already broker-protected on the position.";
  const insertionMarker = source.includes(brokerOnlyInsertionMarker)
    ? brokerOnlyInsertionMarker
    : legacyInsertionMarker;
  source = replaceRequired(
    source,
    insertionMarker,
    `${trailingInsertion}${insertionMarker}`,
    "Sideway post-partial trailing insertion point",
  );

  return source;
}
