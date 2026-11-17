import { Router } from "express";
import { getCandles, getQuote } from "../controllers/market.controller";
const router = Router();
router.get("/quote", getQuote);
router.get("/candles", getCandles);
export default router;
