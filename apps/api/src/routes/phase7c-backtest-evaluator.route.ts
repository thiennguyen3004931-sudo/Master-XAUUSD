import { Router, type Request, type Response } from "express";
import {
  runPhase7CBacktestEvaluator,
  type BacktestEvaluatorRequest,
} from "../services/phase7c-backtest-evaluator.service";

const router = Router();

router.get("/", (req: Request, res: Response) => {
  res.setHeader("cache-control", "no-store");
  const days = req.query.days ? Number(req.query.days) : 90;
  const strategyMode = (req.query.strategyMode as BacktestEvaluatorRequest["strategyMode"]) ?? "AUTO";
  const sizingMode = (req.query.sizingMode as BacktestEvaluatorRequest["sizingMode"]) ?? "CONFIDENCE_TIERED";
  res.json(
    runPhase7CBacktestEvaluator({
      days,
      strategyMode,
      sizingMode,
    }),
  );
});

router.post("/", (req: Request, res: Response) => {
  res.setHeader("cache-control", "no-store");
  res.json(runPhase7CBacktestEvaluator((req.body ?? {}) as BacktestEvaluatorRequest));
});

export default router;
