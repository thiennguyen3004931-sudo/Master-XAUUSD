import { Router, type Request, type Response } from "express";
import { getDashboardSnapshot } from "../services/dashboard.service";
const router = Router();
router.get("/", async (_req: Request, res: Response) => {
  try {
    res.json(await getDashboardSnapshot());
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : "Dashboard pipeline failed." });
  }
});
export default router;
