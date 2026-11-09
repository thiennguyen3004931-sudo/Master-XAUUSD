import type {
  EntryCompressionCandidate,
  Phase4M5Bar,
  Phase4M5CandidateBuildRequest,
  Phase4M5CandidateBuildResult,
} from "../models";

export class Phase4M5CandidateService {
  build(request: Phase4M5CandidateBuildRequest): Phase4M5CandidateBuildResult {
    const maxBars = Math.max(3, request.maxBars ?? 12);
    const eligible = request.bars
      .filter((bar) =>
        bar.openTime >= request.signalTimestamp &&
        bar.closeTime <= request.expiresAt,
      )
      .slice(0, maxBars);

    const candidates: EntryCompressionCandidate[] = [];

    for (let index = 0; index < eligible.length; index += 1) {
      const bar = eligible[index]!;
      const prior1 = eligible[index - 1];
      const prior2 = eligible[index - 2];

      if (prior1 && prior2) {
        if (request.side === "BUY" && bar.low > prior2.high) {
          candidates.push({
            price: prior2.high,
            source: "FVG",
            timestamp: bar.closeTime,
            label: "bullish-fvg-lower-bound",
          });
        }
        if (request.side === "SELL" && bar.high < prior2.low) {
          candidates.push({
            price: prior2.low,
            source: "FVG",
            timestamp: bar.closeTime,
            label: "bearish-fvg-upper-bound",
          });
        }
      }

      const history = eligible.slice(0, index + 1);
      const closes20 = history.slice(-20).map((item) => item.close);
      const closes50 = history.slice(-50).map((item) => item.close);
      const ma20 = average(closes20);
      const ma50 = average(closes50);

      if (closes20.length >= 5 && isFavorable(request.side, ma20, request.canonicalEntry)) {
        candidates.push({ price: ma20, source: "MA20", timestamp: bar.closeTime });
      }
      if (closes50.length >= 10 && isFavorable(request.side, ma50, request.canonicalEntry)) {
        candidates.push({ price: ma50, source: "MA50", timestamp: bar.closeTime });
      }

      const lookback = history.slice(-5);
      if (lookback.length >= 3) {
        const structuralPrice = request.side === "BUY"
          ? Math.min(...lookback.map((item) => item.low))
          : Math.max(...lookback.map((item) => item.high));
        if (isFavorable(request.side, structuralPrice, request.canonicalEntry)) {
          candidates.push({
            price: structuralPrice,
            source: "SUPPLY_DEMAND",
            timestamp: bar.closeTime,
            label: request.side === "BUY" ? "m5-demand-swing" : "m5-supply-swing",
          });
        }
      }

      const profile = volumeWeightedPrice(history.slice(-12));
      if (profile !== null && isFavorable(request.side, profile, request.canonicalEntry)) {
        candidates.push({
          price: profile,
          source: "VOLUME_PROFILE",
          timestamp: bar.closeTime,
          label: "m5-volume-weighted-price",
        });
      }
    }

    const deduped = dedupe(candidates);
    const sources: Record<string, number> = {};
    for (const candidate of deduped) {
      sources[candidate.source] = (sources[candidate.source] ?? 0) + 1;
    }

    return {
      candidates: deduped,
      barsConsidered: eligible.length,
      sources,
    };
  }
}

function average(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function volumeWeightedPrice(bars: readonly Phase4M5Bar[]): number | null {
  const weighted = bars.filter((bar) => Number.isFinite(bar.volume) && (bar.volume ?? 0) > 0);
  if (weighted.length === 0) return null;
  const totalVolume = weighted.reduce((sum, bar) => sum + (bar.volume ?? 0), 0);
  if (totalVolume <= 0) return null;
  return weighted.reduce(
    (sum, bar) => sum + (((bar.high + bar.low + bar.close) / 3) * (bar.volume ?? 0)),
    0,
  ) / totalVolume;
}

function isFavorable(side: "BUY" | "SELL", price: number, canonicalEntry: number): boolean {
  if (!Number.isFinite(price)) return false;
  return side === "BUY" ? price < canonicalEntry : price > canonicalEntry;
}

function dedupe(candidates: readonly EntryCompressionCandidate[]): EntryCompressionCandidate[] {
  const seen = new Set<string>();
  const result: EntryCompressionCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.source}:${candidate.price.toFixed(5)}:${candidate.timestamp}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}
