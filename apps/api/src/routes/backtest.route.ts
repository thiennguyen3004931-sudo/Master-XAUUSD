import { Router, type Request, type Response } from "express";
import type { BacktestRunRequestDto } from "../types/backtest";
import { runPack10Backtest } from "../services/backtest.service";
const router = Router();
router.post("/", async (req: Request, res: Response) => {
  try {
    const input = req.body as BacktestRunRequestDto;
    res.json(await runPack10Backtest(input));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Backtest request failed." });
  }
});
export default router;
