import { Router, type Request, type Response } from "express";
import {
  createPhase7CAccountSwitchPreflight,
  getPhase7CAccountSwitchCapability,
  getPhase7CAccountSwitchStatus,
  getPhase7CSameModeAccountChangeReadiness,
  isPhase7CAccountSwitchTarget,
  submitPhase7CAccountSwitch,
} from "../services/phase7c-account-switch.service";

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
  res.status(403).json({ error: "Account switching is restricted to localhost." });
  return true;
}

router.get("/capability", async (req: Request, res: Response) => {
  if (rejectNonLocal(req, res)) return;
  res.setHeader("cache-control", "no-store");
  try {
    res.json(await getPhase7CAccountSwitchCapability());
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : "Could not inspect account switch capability." });
  }
});

router.get("/same-mode-readiness", async (req: Request, res: Response) => {
  if (rejectNonLocal(req, res)) return;
  res.setHeader("cache-control", "no-store");
  try {
    res.json(await getPhase7CSameModeAccountChangeReadiness());
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : "Could not inspect same-mode account-change readiness." });
  }
});

router.post("/preflight", async (req: Request, res: Response) => {
  if (rejectNonLocal(req, res)) return;
  const targetMode = typeof req.body?.targetMode === "string" ? req.body.targetMode.trim().toUpperCase() : "";
  if (!isPhase7CAccountSwitchTarget(targetMode)) {
    res.status(400).json({ error: "targetMode must be DEMO or LIVE." });
    return;
  }
  try {
    res.setHeader("cache-control", "no-store");
    res.json(await createPhase7CAccountSwitchPreflight(targetMode));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Account switch preflight failed." });
  }
});

router.post("/execute", async (req: Request, res: Response) => {
  if (rejectNonLocal(req, res)) return;
  const targetMode = typeof req.body?.targetMode === "string" ? req.body.targetMode.trim().toUpperCase() : "";
  const preflightToken = typeof req.body?.preflightToken === "string" ? req.body.preflightToken.trim() : "";
  const confirmation = typeof req.body?.confirmation === "string" ? req.body.confirmation.trim().toUpperCase() : "";
  if (!isPhase7CAccountSwitchTarget(targetMode)) {
    res.status(400).json({ error: "targetMode must be DEMO or LIVE." });
    return;
  }
  if (!preflightToken || !confirmation) {
    res.status(400).json({ error: "preflightToken and typed confirmation are required." });
    return;
  }
  try {
    res.status(202).json(await submitPhase7CAccountSwitch({ targetMode, preflightToken, confirmation }));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Account switch request was rejected." });
  }
});

router.get("/status", (req: Request, res: Response) => {
  if (rejectNonLocal(req, res)) return;
  const requestId = typeof req.query.requestId === "string" ? req.query.requestId.trim() : undefined;
  res.setHeader("cache-control", "no-store");
  const status = getPhase7CAccountSwitchStatus(requestId);
  if (!status) {
    res.status(404).json({ error: "Account switch status not found." });
    return;
  }
  res.json(status);
});

export default router;
