import { Router, type Request, type Response } from "express";
import { enablePhase7CAutoFromWeb, evaluatePhase7CAutoActivation } from "../services/phase7c-auto-activation.service";
import { getMt5Telemetry } from "../services/mt5.service";

const router = Router();

function isLoopbackRequest(req: Request): boolean {
  const addresses = [req.ip, req.socket.remoteAddress]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
  return addresses.some((value) =>
    value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1");
}

function rejectNonLocal(req: Request, res: Response): boolean {
  if (isLoopbackRequest(req)) return false;
  res.status(403).json({ error: "AUTO activation is restricted to localhost." });
  return true;
}

router.get("/status", async (req: Request, res: Response) => {
  if (rejectNonLocal(req, res)) return;
  try {
    res.setHeader("cache-control", "no-store");
    res.json(evaluatePhase7CAutoActivation(await getMt5Telemetry("XAUUSD")));
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : "Could not evaluate AUTO activation." });
  }
});

router.post("/enable", async (req: Request, res: Response) => {
  if (rejectNonLocal(req, res)) return;
  try {
    res.setHeader("cache-control", "no-store");
    res.json(enablePhase7CAutoFromWeb(await getMt5Telemetry("XAUUSD")));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "AUTO activation was rejected." });
  }
});

export default router;
