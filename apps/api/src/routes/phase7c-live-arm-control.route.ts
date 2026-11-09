import { Router, type Request, type Response } from "express";
import {
  createPhase7CLiveArmPreflight,
  getPhase7CLiveArmControlCapability,
  getPhase7CLiveArmControlStatus,
  submitPhase7CLiveArmControl,
  type Phase7CLiveArmAction,
} from "../services/phase7c-live-arm-control.service";

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
  res.status(403).json({ error: "LIVE ARM control is restricted to localhost." });
  return true;
}

function readAction(value: unknown): Phase7CLiveArmAction | null {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  return normalized === "ARM_LIVE" || normalized === "DISARM_LIVE" ? normalized : null;
}

router.get("/capability", async (req: Request, res: Response) => {
  if (rejectNonLocal(req, res)) return;
  try {
    res.setHeader("cache-control", "no-store");
    res.json(await getPhase7CLiveArmControlCapability());
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : "Could not inspect LIVE ARM capability." });
  }
});

router.post("/preflight", async (req: Request, res: Response) => {
  if (rejectNonLocal(req, res)) return;
  const action = readAction(req.body?.action);
  if (!action) {
    res.status(400).json({ error: "action must be ARM_LIVE or DISARM_LIVE." });
    return;
  }
  try {
    res.setHeader("cache-control", "no-store");
    res.json(await createPhase7CLiveArmPreflight(action));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "LIVE ARM preflight failed." });
  }
});

router.post("/execute", async (req: Request, res: Response) => {
  if (rejectNonLocal(req, res)) return;
  const action = readAction(req.body?.action);
  const preflightToken = typeof req.body?.preflightToken === "string" ? req.body.preflightToken.trim() : "";
  const confirmation = typeof req.body?.confirmation === "string" ? req.body.confirmation.trim().toUpperCase() : "";
  if (!action) {
    res.status(400).json({ error: "action must be ARM_LIVE or DISARM_LIVE." });
    return;
  }
  if (!preflightToken || !confirmation) {
    res.status(400).json({ error: "preflightToken and confirmation are required." });
    return;
  }
  try {
    res.status(202).json(await submitPhase7CLiveArmControl({ action, preflightToken, confirmation }));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "LIVE ARM control request was rejected." });
  }
});

router.get("/status", (req: Request, res: Response) => {
  if (rejectNonLocal(req, res)) return;
  const requestId = typeof req.query.requestId === "string" ? req.query.requestId.trim() : undefined;
  res.setHeader("cache-control", "no-store");
  const status = getPhase7CLiveArmControlStatus(requestId);
  if (!status) {
    res.status(404).json({ error: "LIVE ARM control status not found." });
    return;
  }
  res.json(status);
});

export default router;
