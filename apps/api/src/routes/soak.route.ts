import {
  Router,
  type Request,
  type Response,
} from "express";

import {
  getAutoExecutionSoakStatus,
} from "../services/auto-execution-soak.service";

const router = Router();

// Read-only telemetry. No endpoint exists to start trading,
// submit an order, close a position, or unlock LIVE.
router.get("/status", (_req: Request, res: Response) => {
  res.json(getAutoExecutionSoakStatus());
});

export default router;