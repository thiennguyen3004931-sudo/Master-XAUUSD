import type { Request, Response } from "express";
import { parseTimeframe } from "../utils/timeframe";
import * as marketService from "../services/market.service";

export async function getQuote(req: Request, res: Response) {
  const symbol = String(req.query.symbol ?? "XAUUSD");
  res.json({ success: true, data: await marketService.getQuote(symbol), timestamp: Date.now() });
}

export async function getCandles(req: Request, res: Response) {
  try {
    const symbol = String(req.query.symbol ?? "XAUUSD");
    const timeframe = parseTimeframe(String(req.query.tf ?? "M15"));
    const limit = Math.max(20, Math.min(5_000, Number(req.query.limit ?? 500)));
    const data = await marketService.getCandles(symbol, timeframe, limit);
    res.json({ success: true, data, timestamp: Date.now() });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid market request." });
  }
}
