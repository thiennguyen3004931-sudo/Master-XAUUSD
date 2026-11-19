import { Router, type Request, type Response } from "express";
import { getPhase7CCounterfactualIntelligence } from "../services/phase7c-counterfactual-intelligence.service";

const router = Router();

function isLoopbackRequest(req: Request): boolean {
  const addresses = [req.ip, req.socket.remoteAddress]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
  return addresses.some((value) =>
    value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1");
}

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
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("limit must be an integer between 1 and 200.");
  }
  return limit;
}

router.get("/", async (req: Request, res: Response) => {
  if (!isLoopbackRequest(req)) {
    res.status(403).json({ error: "Counterfactual intelligence is restricted to localhost." });
    return;
  }
  try {
    const symbol = typeof req.query.symbol === "string" ? req.query.symbol : "XAUUSD";
    res.setHeader("cache-control", "no-store");
    res.json(
      await getPhase7CCounterfactualIntelligence({
        days: readDays(req.query.days),
        symbol,
        limit: readLimit(req.query.limit),
      }),
    );
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error
        ? error.message
        : "Could not build Phase7C counterfactual intelligence snapshot.",
    });
  }
});

export default router;
