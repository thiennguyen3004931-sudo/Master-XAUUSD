import { Router, type Request, type Response } from "express";
import { getControlState, setControlMode } from "../services/control.service";
const router = Router();
router.get("/mode", (_req: Request, res: Response) => res.json(getControlState()));
router.post("/mode", (req: Request, res: Response) => {
  const mode = String(req.body?.mode ?? "").toUpperCase();
  if (mode !== "SHADOW" && mode !== "DEMO") {
    res.status(400).json({ error: "Only SHADOW and DEMO are allowed. LIVE cannot be enabled here." });
    return;
  }
  res.json(setControlMode(mode));
});
export default router;
