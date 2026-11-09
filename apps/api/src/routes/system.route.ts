import { Router, type Request, type Response } from "express";
import { getDashboardSnapshot } from "../services/dashboard.service";
const router = Router();
router.get("/health", async (_req: Request, res: Response) => {
  try {
    const snapshot = await getDashboardSnapshot();
    res.json({ healthy: snapshot.services.every((service) => service.status !== "OFFLINE"), generatedAt: snapshot.generatedAt, services: snapshot.services, control: snapshot.control });
  } catch (error) {
    res.status(503).json({ healthy: false, error: error instanceof Error ? error.message : "System health failed." });
  }
});
export default router;
