import { Router, type Request, type Response } from "express";
import type { Phase7CPerformanceCorrelationVerdict } from "../contracts/phase7c-performance-correlation.schema";
import { buildPhase7CPerformanceCorrelationBackfill } from "../services/phase7c-performance-correlation.service";
import { getPhase7CPerformanceIntelligence } from "../services/phase7c-performance-intelligence.service";

const router = Router();

function readDays(value: unknown): number {
  if (value === undefined) return 90;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 7 || days > 365) {
    throw new Error("days must be an integer between 7 and 365.");
  }
  return days;
}

function readLimit(value: unknown): number {
  if (value === undefined) return 100;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("limit must be an integer between 1 and 500.");
  }
  return limit;
}

function readVerdict(value: unknown): Phase7CPerformanceCorrelationVerdict | null {
  if (value === undefined) return null;
  if (value === "EXACT" || value === "AMBIGUOUS" || value === "UNMATCHED") return value;
  throw new Error("verdict must be EXACT, AMBIGUOUS, or UNMATCHED.");
}

function readStrategy(value: unknown): "TREND" | "SIDEWAY" | null {
  if (value === undefined) return null;
  if (value === "TREND" || value === "SIDEWAY") return value;
  throw new Error("strategy must be TREND or SIDEWAY.");
}

router.get("/correlations", async (req: Request, res: Response) => {
  try {
    const days = readDays(req.query.days);
    const symbol = typeof req.query.symbol === "string" ? req.query.symbol : "XAUUSD";
    res.setHeader("cache-control", "no-store");
    res.json(
      await buildPhase7CPerformanceCorrelationBackfill(days, symbol, {
        verdict: readVerdict(req.query.verdict),
        strategy: readStrategy(req.query.strategy),
        limit: readLimit(req.query.limit),
      }),
    );
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Could not build Phase7C correlation backfill.",
    });
  }
});

router.get("/", async (req: Request, res: Response) => {
  try {
    const days = readDays(req.query.days);
    const symbol = typeof req.query.symbol === "string" ? req.query.symbol : "XAUUSD";
    res.setHeader("cache-control", "no-store");
    res.json(await getPhase7CPerformanceIntelligence(days, symbol));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Could not build Phase7C performance intelligence.",
    });
  }
});

export default router;
