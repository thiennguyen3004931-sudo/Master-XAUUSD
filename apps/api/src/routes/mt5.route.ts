import { Router, type Request, type Response } from "express";
import { getMt5Telemetry } from "../services/mt5.service";
import { getMt5PerformanceSnapshot } from "../services/mt5-performance.service";

const router = Router();

// Telemetry-only boundary.
// Intentionally no POST /orders, DELETE /orders or position mutation routes here.
router.get("/status", async (req: Request, res: Response) => {
  const symbol = String(req.query.symbol ?? "XAUUSD").trim().toUpperCase();
  const telemetry = await getMt5Telemetry(symbol || "XAUUSD");
  res.status(telemetry.status === "OFFLINE" ? 503 : 200).json(telemetry);
});

router.get("/health", async (_req: Request, res: Response) => {
  const telemetry = await getMt5Telemetry("XAUUSD");
  res.status(telemetry.status === "OFFLINE" ? 503 : 200).json({
    enabled: telemetry.enabled,
    configured: telemetry.configured,
    reachable: telemetry.reachable,
    status: telemetry.status,
    message: telemetry.message,
    latencyMs: telemetry.latencyMs,
    health: telemetry.health,
    checkedAt: telemetry.checkedAt,
  });
});


router.get("/performance", async (req: Request, res: Response) => {
  try {
    const days = Number(req.query.days ?? 90);
    const symbol = String(req.query.symbol ?? "XAUUSD")
      .trim()
      .toUpperCase();

    res.json(
      await getMt5PerformanceSnapshot(
        days,
        symbol || "XAUUSD",
      ),
    );
  } catch (error) {
    res.status(503).json({
      error:
        error instanceof Error
          ? error.message
          : "MT5 performance analytics failed.",
    });
  }
});
export default router;
