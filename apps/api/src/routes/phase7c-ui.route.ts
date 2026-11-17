import { Router, type Request, type Response } from "express";
import { getPhase7CDecisionMonitor } from "../services/phase7c-decision-monitor.service";
import {
  buildPhase7CUiContract,
  formatPhase7CUiContractForMt5,
} from "../services/phase7c-ui-contract.service";

const router = Router();

router.get("/", async (req: Request, res: Response) => {
  try {
    const symbol = String(req.query.symbol ?? "XAUUSD").trim().toUpperCase() || "XAUUSD";
    const snapshot = await getPhase7CDecisionMonitor(symbol);
    res.setHeader("cache-control", "no-store");
    res.json(buildPhase7CUiContract(snapshot));
  } catch (error) {
    res.status(503).json({
      error: error instanceof Error ? error.message : "Phase 7C UI contract failed.",
    });
  }
});

router.get("/mt5", async (req: Request, res: Response) => {
  try {
    const symbol = String(req.query.symbol ?? "XAUUSD").trim().toUpperCase() || "XAUUSD";
    const snapshot = await getPhase7CDecisionMonitor(symbol);
    const ui = buildPhase7CUiContract(snapshot);
    res.setHeader("cache-control", "no-store");
    res.type("text/plain; charset=utf-8").send(formatPhase7CUiContractForMt5(ui));
  } catch (error) {
    res.status(503).type("text/plain; charset=utf-8").send(
      `error=${error instanceof Error ? error.message.replace(/[\r\n]+/g, " ") : "Phase 7C MT5 UI contract failed."}\n`,
    );
  }
});

export default router;
