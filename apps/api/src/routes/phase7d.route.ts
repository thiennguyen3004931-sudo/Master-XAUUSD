import { Router, type Request, type Response } from "express";
import {
  runPhase7DDailyPnlResearch,
  type Phase7DDailyPnlRequest,
} from "../services/phase7d-daily-pnl.service";
import {
  runPhase7DManagementResearch,
  type Phase7DManagementRequest,
} from "../services/phase7d-management.service";
import {
  type Phase7DDailyScaleRequest,
} from "../services/phase7d-daily-scale.service";
import {
  runPhase7DReconciledDailyScaleResearch,
} from "../services/phase7d-daily-scale-reconcile.service";

const router = Router();

router.post("/daily-pnl-backtest", async (req: Request, res: Response) => {
  try {
    res.json(await runPhase7DDailyPnlResearch(req.body as Phase7DDailyPnlRequest));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Phase 7D daily P/L research failed.",
    });
  }
});

router.post("/management-backtest", async (req: Request, res: Response) => {
  try {
    res.json(await runPhase7DManagementResearch(req.body as Phase7DManagementRequest));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Phase 7D BE/partial management research failed.",
    });
  }
});

router.post("/daily-scale-backtest", async (req: Request, res: Response) => {
  try {
    res.json(await runPhase7DReconciledDailyScaleResearch(req.body as Phase7DDailyScaleRequest));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Phase 7D reconciled daily recovery/trend scale research failed.",
    });
  }
});

export default router;
