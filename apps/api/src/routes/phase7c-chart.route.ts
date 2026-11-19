import { Router, type Request, type Response } from "express";
import { getPhase7CM15Candles } from "../services/phase7c-live-regime.service";

const router = Router();

router.get("/candles", async (req: Request, res: Response) => {
  try {
    const symbol = String(req.query.symbol ?? "XAUUSD").trim().toUpperCase() || "XAUUSD";
    const count = Number(req.query.count ?? 240);
    res.setHeader("cache-control", "no-store");
    res.json(await getPhase7CM15Candles(symbol, count));
  } catch (error) {
    res.status(503).json({
      error: error instanceof Error ? error.message : "Phase 7C chart candles failed.",
    });
  }
});

export default router;
