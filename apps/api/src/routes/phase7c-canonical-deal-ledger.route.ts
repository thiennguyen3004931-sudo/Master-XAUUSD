import { Router, type Request, type Response } from "express";
import {
  accountModeAllowsBroker,
  getPhase7CAccountModeState,
} from "../services/phase7c-account-mode.service";
import {
  getPhase7CCanonicalPositionRealizedDeals,
} from "../services/phase7c-canonical-deal-ledger.service";
import { resolvePhase7CDailyRecoveryMagicNumbers } from "../services/phase7c-daily-recovery-view.service";
import { getMt5Telemetry } from "../services/mt5.service";

const router = Router();
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BACKFILL_DAYS = 365;

router.get("/position-realized", async (req: Request, res: Response) => {
  try {
    const positionId = String(req.query.positionId ?? "").trim();
    const symbol = String(req.query.symbol ?? "XAUUSD").trim().toUpperCase();

    if (!positionId) {
      res.status(400).json({ error: "positionId is required." });
      return;
    }
    if (symbol !== "XAUUSD") {
      res.status(400).json({ error: "Canonical Phase 7C realized accounting currently supports XAUUSD only." });
      return;
    }

    const telemetry = await getMt5Telemetry(symbol);
    const accountModeState = getPhase7CAccountModeState();

    if (
      !telemetry.reachable ||
      !telemetry.health?.connected ||
      !accountModeAllowsBroker(telemetry.health.accountMode, accountModeState)
    ) {
      res.status(503).json({
        error: `Canonical realized accounting requires connected ${accountModeState.accountMode} MT5 telemetry matching configured account mode.`,
      });
      return;
    }

    const brokerNow = Number(telemetry.quote?.timestamp ?? Date.now());
    const requestedToMs = Number(req.query.toMs ?? brokerNow);
    const toMs = Number.isFinite(requestedToMs) && requestedToMs > 0
      ? Math.min(requestedToMs, brokerNow)
      : brokerNow;
    const requestedFromMs = Number(req.query.fromMs);
    const fromMs = Number.isFinite(requestedFromMs) && requestedFromMs >= 0 && requestedFromMs < toMs
      ? requestedFromMs
      : Math.max(0, toMs - DEFAULT_BACKFILL_DAYS * DAY_MS);

    const magicNumbers = resolvePhase7CDailyRecoveryMagicNumbers({
      accountMode: accountModeState.accountMode,
    });
    const realized = await getPhase7CCanonicalPositionRealizedDeals({
      telemetry,
      symbol,
      positionId,
      ownedMagics: magicNumbers.configuredMagicNumbers,
      fromMs,
      toMs,
    });

    res.setHeader("cache-control", "no-store");
    res.json({
      source: "CANONICAL_MT5_DEAL_LEDGER",
      readOnly: true,
      symbol,
      positionId,
      fromMs,
      toMs,
      dealCount: realized.deals.length,
      realizedNetPnl: realized.realizedNetPnl,
      deals: realized.deals.map((deal) => ({
        ticket: deal.ticket,
        positionId: deal.positionId,
        side: deal.side,
        entry: deal.entry,
        volume: deal.volume,
        price: deal.price,
        profit: deal.profit,
        commission: deal.commission,
        swap: deal.swap,
        fee: deal.fee,
        netPnl: deal.netPnl,
        magic: deal.magic,
        timestamp: deal.timestamp,
      })),
    });
  } catch (error) {
    res.status(503).json({
      error: error instanceof Error ? error.message : "Canonical realized accounting failed.",
    });
  }
});

export default router;
