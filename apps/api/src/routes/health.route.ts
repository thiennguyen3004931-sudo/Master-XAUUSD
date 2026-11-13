import { Router, type Request, type Response } from "express";
const router = Router();
router.get("/", (_req: Request, res: Response) => {
  res.json({ success: true, data: { status: "OK", service: "XAUUSD AI MASTER API", version: "12-pack-fix-1" }, timestamp: Date.now() });
});
export default router;
