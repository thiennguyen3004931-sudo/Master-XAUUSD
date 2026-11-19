export function eventTimeMs(row) {
  if (!row || typeof row !== "object") return null;
  const candidates = [row.timestamp, row.timestampMs, row.createdAt, row.openedAt];
  for (const value of candidates) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

export function filterWindow(rows, fromMs, toMs) {
  return rows.filter((row) => {
    const time = eventTimeMs(row);
    return time !== null && time >= fromMs && time <= toMs;
  });
}

export function dedupeAutoDecisions(rows, duplicateWindowMs = 30_000) {
  const sorted = rows
    .filter((row) => row?.type === "AUTO_DECISION" && eventTimeMs(row) !== null)
    .slice()
    .sort((a, b) => eventTimeMs(a) - eventTimeMs(b));
  const result = [];
  let previousFingerprint = null;
  let previousTime = null;

  for (const row of sorted) {
    const time = eventTimeMs(row);
    const reasons = Array.isArray(row?.reasons) ? row.reasons.map(String).slice().sort() : [];
    const fingerprint = JSON.stringify({
      activeMode: row?.activeMode ?? null,
      regime: row?.regime ?? null,
      recommendedMode: row?.recommendedMode ?? null,
      confidence: finiteNumber(row?.confidence),
      lastCandleCloseTime: finiteNumber(row?.lastCandleCloseTime),
      reasons,
    });
    const duplicate =
      previousFingerprint === fingerprint &&
      previousTime !== null &&
      time - previousTime >= 0 &&
      time - previousTime <= duplicateWindowMs;
    if (duplicate) continue;
    result.push(row);
    previousFingerprint = fingerprint;
    previousTime = time;
  }
  return result;
}

export function countByType(rows) {
  const counts = {};
  for (const row of rows) {
    const type = String(row?.type ?? "UNKNOWN");
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return sortObjectByValue(counts);
}

export function blockedReasonCounts(rows) {
  const counts = {};
  for (const row of rows) {
    const type = String(row?.type ?? "");
    if (!/(BLOCK|REJECTED|EXPIRED|NO_ENTRY_SIGNAL|INVALID|UNMANAGED|ERROR)/.test(type)) continue;
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return sortObjectByValue(counts);
}

export function nearestDecision(decisions, atMs) {
  let selected = null;
  for (const row of decisions) {
    const time = eventTimeMs(row);
    if (time === null || time > atMs) continue;
    if (selected === null || time > eventTimeMs(selected)) selected = row;
  }
  return selected;
}

export function buildEntryRows(trendRows, sidewayRows, decisions) {
  const entries = [];
  for (const [strategy, rows] of [["TREND", trendRows], ["SIDEWAY", sidewayRows]]) {
    for (const row of rows) {
      if (row?.type !== "ENTRY_FILLED") continue;
      const timestamp = eventTimeMs(row);
      if (timestamp === null) continue;
      const position = row.position ?? {};
      const decision = nearestDecision(decisions, timestamp);
      entries.push({
        timestamp,
        timestampIso: new Date(timestamp).toISOString(),
        strategy,
        ticket: String(position.ticket ?? row.ticket ?? ""),
        side: String(position.side ?? row.side ?? row.management?.side ?? ""),
        volume: finiteNumber(position.volume ?? row.management?.initialVolume),
        entryPrice: finiteNumber(position.entry ?? row.fillPrice ?? row.management?.entry),
        regime: decision?.regime ?? null,
        recommendedMode: decision?.recommendedMode ?? null,
        activeMode: decision?.activeMode ?? null,
        confidence: finiteNumber(decision?.confidence),
      });
    }
  }
  return entries.sort((a, b) => a.timestamp - b.timestamp);
}

export function summarizeDeals(deals, trendMagic, sidewayMagic, window = {}) {
  const summary = {
    TREND: emptyDealSummary(),
    SIDEWAY: emptyDealSummary(),
    OTHER: emptyDealSummary(),
  };
  const positions = buildPositionIndex(deals, trendMagic, sidewayMagic);
  const fromMs = finiteNumber(window.fromMs);
  const toMs = finiteNumber(window.toMs);
  const explicitPositionBaselineMs = finiteNumber(window.positionOpenedAfterMs);
  const requirePositionOpenedInWindow = Boolean(window.requirePositionOpenedInWindow);
  const minimumPositionOpenMs = explicitPositionBaselineMs ?? (requirePositionOpenedInWindow ? fromMs : null);

  for (const deal of deals) {
    if (!deal?.isTradingDeal) continue;
    const timestamp = eventTimeMs(deal);
    if (fromMs !== null && (timestamp === null || timestamp < fromMs)) continue;
    if (toMs !== null && (timestamp === null || timestamp > toMs)) continue;

    const positionId = String(deal.positionId ?? "");
    const position = positionId ? positions.get(positionId) : null;
    if (minimumPositionOpenMs !== null) {
      if (positionId) {
        if (!position || position.openedAt === null || position.openedAt < minimumPositionOpenMs) continue;
      } else {
        const entry = String(deal.entry ?? "");
        if (!["IN", "INOUT"].includes(entry) || timestamp < minimumPositionOpenMs) continue;
      }
    }

    const bucket = position?.owner ?? classifyDealOwner(deal, trendMagic, sidewayMagic);
    const target = summary[bucket];
    target.deals += 1;
    target.volume += finiteNumber(deal.volume) ?? 0;
    target.profit += finiteNumber(deal.profit) ?? 0;
    target.commission += finiteNumber(deal.commission) ?? 0;
    target.swap += finiteNumber(deal.swap) ?? 0;
    target.fee += finiteNumber(deal.fee) ?? 0;
    target.netPnl += finiteNumber(deal.netPnl) ?? 0;
    if (String(deal.entry) === "IN") target.entryDeals += 1;
    if (["OUT", "OUT_BY", "INOUT"].includes(String(deal.entry))) target.exitDeals += 1;
  }
  for (const value of Object.values(summary)) roundSummary(value);
  return summary;
}

export function summarizeClosedPositions(deals, trendMagic, sidewayMagic, window = {}) {
  const positions = buildPositionIndex(deals, trendMagic, sidewayMagic);
  const fromMs = finiteNumber(window.fromMs);
  const toMs = finiteNumber(window.toMs);
  const baselineMs = finiteNumber(window.positionOpenedAfterMs);
  const rows = [];
  const summary = {
    TREND: emptyTradeSummary(),
    SIDEWAY: emptyTradeSummary(),
    OTHER: emptyTradeSummary(),
  };

  for (const position of positions.values()) {
    if (position.openedAt === null || position.closedAt === null) continue;
    if (baselineMs !== null && position.openedAt < baselineMs) continue;
    if (fromMs !== null && position.closedAt < fromMs) continue;
    if (toMs !== null && position.closedAt > toMs) continue;
    if (!(position.inVolume > 0) || position.outVolume + 1e-8 < position.inVolume) continue;

    let netPnl = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    for (const deal of position.deals) {
      const value = finiteNumber(deal.netPnl) ?? 0;
      netPnl += value;
      if (value > 0) grossProfit += value;
      if (value < 0) grossLoss += value;
    }
    netPnl = round4(netPnl);
    grossProfit = round4(grossProfit);
    grossLoss = round4(grossLoss);

    const target = summary[position.owner];
    target.trades += 1;
    target.netPnl += netPnl;
    target.grossProfit += grossProfit;
    target.grossLoss += grossLoss;
    if (netPnl > 0.0001) target.wins += 1;
    else if (netPnl < -0.0001) target.losses += 1;
    else target.breakeven += 1;

    rows.push({
      positionId: position.positionId,
      strategy: position.owner,
      openedAt: position.openedAt,
      openedAtIso: new Date(position.openedAt).toISOString(),
      closedAt: position.closedAt,
      closedAtIso: new Date(position.closedAt).toISOString(),
      openedVolume: round4(position.inVolume),
      closedVolume: round4(position.outVolume),
      netPnl,
    });
  }

  for (const target of Object.values(summary)) finalizeTradeSummary(target);
  rows.sort((a, b) => b.closedAt - a.closedAt);
  return { ...summary, rows };
}

export function regimeDistribution(decisions) {
  const regime = {};
  const recommended = {};
  const active = {};
  for (const row of decisions) {
    if (row?.type !== "AUTO_DECISION") continue;
    increment(regime, String(row.regime ?? "UNKNOWN"));
    increment(recommended, String(row.recommendedMode ?? "UNKNOWN"));
    increment(active, String(row.activeMode ?? "UNKNOWN"));
  }
  return {
    regime: sortObjectByValue(regime),
    recommendedMode: sortObjectByValue(recommended),
    activeMode: sortObjectByValue(active),
  };
}

function buildPositionIndex(deals, trendMagic, sidewayMagic) {
  const positions = new Map();
  for (const deal of deals) {
    if (!deal?.isTradingDeal) continue;
    const positionId = String(deal.positionId ?? "");
    if (!positionId) continue;
    const timestamp = eventTimeMs(deal);
    const entry = String(deal.entry ?? "");
    const volume = Math.max(0, finiteNumber(deal.volume) ?? 0);
    let position = positions.get(positionId);
    if (!position) {
      position = {
        positionId,
        owner: "OTHER",
        openedAt: null,
        closedAt: null,
        inVolume: 0,
        outVolume: 0,
        deals: [],
      };
      positions.set(positionId, position);
    }
    position.deals.push(deal);

    if (["IN", "INOUT"].includes(entry)) {
      const owner = classifyDealOwner(deal, trendMagic, sidewayMagic);
      if (position.owner === "OTHER" && owner !== "OTHER") position.owner = owner;
      if (timestamp !== null && (position.openedAt === null || timestamp < position.openedAt)) {
        position.openedAt = timestamp;
      }
      if (entry === "IN") position.inVolume += volume;
    }
    if (["OUT", "OUT_BY", "INOUT"].includes(entry)) {
      position.outVolume += volume;
      if (timestamp !== null && (position.closedAt === null || timestamp > position.closedAt)) {
        position.closedAt = timestamp;
      }
    }
  }
  return positions;
}

function classifyDealOwner(deal, trendMagic, sidewayMagic) {
  const magic = Number(deal?.magic);
  if (magic === sidewayMagic) return "SIDEWAY";
  if (magic === trendMagic) return "TREND";
  const comment = String(deal?.comment ?? "").toLowerCase();
  if (comment.includes("phase7c-sideway") || comment.includes("p7c-sideway")) return "SIDEWAY";
  if (comment.includes("phase7b-demo") || comment.includes("p7b-")) return "TREND";
  return "OTHER";
}

function emptyDealSummary() {
  return { deals: 0, entryDeals: 0, exitDeals: 0, volume: 0, profit: 0, commission: 0, swap: 0, fee: 0, netPnl: 0 };
}

function emptyTradeSummary() {
  return { trades: 0, wins: 0, losses: 0, breakeven: 0, winRate: 0, grossProfit: 0, grossLoss: 0, netPnl: 0, profitFactor: null };
}

function roundSummary(value) {
  for (const key of ["volume", "profit", "commission", "swap", "fee", "netPnl"]) {
    value[key] = round4(value[key]);
  }
}

function finalizeTradeSummary(value) {
  value.grossProfit = round4(value.grossProfit);
  value.grossLoss = round4(value.grossLoss);
  value.netPnl = round4(value.netPnl);
  value.winRate = value.trades > 0 ? round4((value.wins / value.trades) * 100) : 0;
  value.profitFactor = value.grossLoss < -0.0001
    ? round4(value.grossProfit / Math.abs(value.grossLoss))
    : value.grossProfit > 0.0001
      ? null
      : 0;
}

function increment(target, key) {
  target[key] = (target[key] ?? 0) + 1;
}

function sortObjectByValue(input) {
  return Object.fromEntries(Object.entries(input).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round4(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;
}
