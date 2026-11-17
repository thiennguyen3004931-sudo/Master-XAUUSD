export interface BrokerDayAccountingDeal {
  isTradingDeal?: boolean;
  magic?: number | string | null;
  netPnl?: number | string | null;
}

export interface BrokerDayRealizedPnlSummary {
  dealCount: number;
  dailyNetPnl: number;
}

export function summarizeBrokerDayRealizedPnl(
  deals: readonly BrokerDayAccountingDeal[],
  systemMagicNumbers: Iterable<number>,
): BrokerDayRealizedPnlSummary {
  const ownedMagics = new Set(
    Array.from(systemMagicNumbers, (magic) => Number(magic)),
  );

  let dealCount = 0;
  let dailyNetPnl = 0;

  for (const deal of deals) {
    if (
      deal.isTradingDeal !== true ||
      !ownedMagics.has(Number(deal.magic))
    ) {
      continue;
    }

    dealCount += 1;
    dailyNetPnl += Number(deal.netPnl || 0);
  }

  return { dealCount, dailyNetPnl };
}

export function computeBrokerDayRealizedPnl(
  deals: readonly BrokerDayAccountingDeal[],
  systemMagicNumbers: Iterable<number>,
): number {
  return summarizeBrokerDayRealizedPnl(
    deals,
    systemMagicNumbers,
  ).dailyNetPnl;
}
