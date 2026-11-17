import { Router, type Request, type Response } from "express";
import { getPhase7CPatternAdvisorSnapshot } from "../services/phase7c-pattern-advisor.service";

const router = Router();

router.get("/", async (req: Request, res: Response) => {
  try {
    const symbol = typeof req.query.symbol === "string" ? req.query.symbol : "XAUUSD";
    const snapshot = await getPhase7CPatternAdvisorSnapshot(symbol);
    res.json(snapshot);
  } catch (error) {
    res.status(503).json({
      error: error instanceof Error ? error.message : "Phase 7C pattern advisor unavailable.",
    });
  }
});

export default router;
