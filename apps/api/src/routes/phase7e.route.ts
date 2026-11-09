import { Router, type Request, type Response } from "express";
import {
  runPhase7ESupertrendResearch,
  type Phase7ESupertrendRequest,
} from "../services/phase7e-supertrend.service";
import {
  runPhase7ERealignmentResearch,
  type Phase7ERealignmentRequest,
} from "../services/phase7e-realignment.service";

const router = Router();

router.post("/supertrend-backtest", async (req: Request, res: Response) => {
  try {
    res.json(await runPhase7ESupertrendResearch(req.body as Phase7ESupertrendRequest));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Phase 7E dual Supertrend research failed.",
    });
  }
});

router.post("/realignment-backtest", async (req: Request, res: Response) => {
  try {
    res.json(await runPhase7ERealignmentResearch(req.body as Phase7ERealignmentRequest));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Phase 7E M5 realignment research failed.",
    });
  }
});

export default router;
