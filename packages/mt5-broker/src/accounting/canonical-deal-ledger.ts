import type { Mt5BridgeDeal } from "../models/Mt5BridgeDeal";

export interface CanonicalDealRecord extends Mt5BridgeDeal {
  account: string;
  netPnl: number;
}

export interface CanonicalDealLedgerStore {
  load(): string | null;
  save(serializedState: string): void;
}

export interface CanonicalDealLedgerOptions {
  store: CanonicalDealLedgerStore;
}

export interface CanonicalDealSummaryQuery {
  account: string;
  symbol: string;
  ownedMagics: Iterable<number>;
  from: number;
  to: number;
}

export interface CanonicalPositionClosingDealsQuery {
  account: string;
  positionId: string;
  symbol: string;
  ownedMagics: Iterable<number>;
}

export interface CanonicalDealLedgerSummary {
  dealCount: number;
  dailyNetPnl: number;
}

interface PersistedCanonicalDealLedger {
  version: 1;
  deals: CanonicalDealRecord[];
}

const CLOSING_ENTRIES = new Set<Mt5BridgeDeal["entry"]>([
  "OUT",
  "INOUT",
  "OUT_BY",
]);

export class CanonicalDealLedger {
  readonly #store: CanonicalDealLedgerStore;
  readonly #dealsByIdentity = new Map<string, CanonicalDealRecord>();

  constructor(options: CanonicalDealLedgerOptions) {
    if (!options?.store) {
      throw new Error("CanonicalDealLedger store is required");
    }

    this.#store = options.store;
    this.#restore();
  }

  get size(): number {
    return this.#dealsByIdentity.size;
  }

  mergeBackfill(
    account: string,
    deals: readonly Mt5BridgeDeal[],
  ): { inserted: number; total: number } {
    const normalizedAccount = requireText(account, "account");
    let inserted = 0;
    let changed = false;

    for (const deal of deals) {
      const normalized = canonicalizeDeal(normalizedAccount, deal);
      const identity = dealIdentity(normalized.account, normalized.ticket);
      const existing = this.#dealsByIdentity.get(identity);
      if (existing) {
        if (sameCanonicalDeal(existing, normalized)) {
          continue;
        }
        this.#dealsByIdentity.set(identity, normalized);
        changed = true;
        continue;
      }

      this.#dealsByIdentity.set(identity, normalized);
      inserted += 1;
      changed = true;
    }

    if (changed) {
      this.#persist();
    }

    return { inserted, total: this.size };
  }

  deals(): CanonicalDealRecord[] {
    return Array.from(this.#dealsByIdentity.values())
      .map((deal) => ({ ...deal }))
      .sort(compareDeals);
  }

  summarize(query: CanonicalDealSummaryQuery): CanonicalDealLedgerSummary {
    const ownedMagics = new Set(
      Array.from(query.ownedMagics, (magic) => Number(magic)),
    );
    const ownedPositionIds = collectOwnedPositionIds(
      this.#dealsByIdentity.values(),
      query.account,
      query.symbol,
      ownedMagics,
    );
    let dealCount = 0;
    let dailyNetPnl = 0;

    for (const deal of this.#dealsByIdentity.values()) {
      const directlyOwned = ownedMagics.has(Number(deal.magic));
      const magicZeroOwnedPositionClose =
        Number(deal.magic) === 0 &&
        ownedPositionIds.has(deal.positionId) &&
        CLOSING_ENTRIES.has(deal.entry);

      if (
        deal.account !== query.account ||
        deal.symbol !== query.symbol ||
        deal.isTradingDeal !== true ||
        (!directlyOwned && !magicZeroOwnedPositionClose) ||
        deal.timestamp < query.from ||
        deal.timestamp >= query.to
      ) {
        continue;
      }

      dealCount += 1;
      dailyNetPnl += deal.netPnl;
    }

    return {
      dealCount,
      dailyNetPnl: normalizeNumber(dailyNetPnl),
    };
  }

  realizedClosingDeals(
    query: CanonicalPositionClosingDealsQuery,
  ): CanonicalDealRecord[] {
    const ownedMagics = new Set(
      Array.from(query.ownedMagics, (magic) => Number(magic)),
    );
    const ownedPositionIds = collectOwnedPositionIds(
      this.#dealsByIdentity.values(),
      query.account,
      query.symbol,
      ownedMagics,
    );

    if (!ownedPositionIds.has(query.positionId)) {
      return [];
    }

    return Array.from(this.#dealsByIdentity.values())
      .filter((deal) => {
        const closeMagic = Number(deal.magic);
        return (
          deal.account === query.account &&
          deal.positionId === query.positionId &&
          deal.symbol === query.symbol &&
          deal.isTradingDeal === true &&
          CLOSING_ENTRIES.has(deal.entry) &&
          (ownedMagics.has(closeMagic) || closeMagic === 0)
        );
      })
      .map((deal) => ({ ...deal }))
      .sort(compareDeals);
  }

  #restore(): void {
    const raw = this.#store.load()?.trim() ?? "";
    if (!raw) {
      return;
    }

    const parsed = JSON.parse(raw) as Partial<PersistedCanonicalDealLedger>;
    if (parsed.version !== 1 || !Array.isArray(parsed.deals)) {
      throw new Error("Unsupported canonical deal ledger state");
    }

    for (const persisted of parsed.deals) {
      const account = requireText(persisted?.account, "account");
      const normalized = canonicalizeDeal(account, persisted);
      this.#dealsByIdentity.set(
        dealIdentity(normalized.account, normalized.ticket),
        normalized,
      );
    }
  }

  #persist(): void {
    const payload: PersistedCanonicalDealLedger = {
      version: 1,
      deals: this.deals(),
    };

    this.#store.save(`${JSON.stringify(payload, null, 2)}\n`);
  }
}

function collectOwnedPositionIds(
  deals: Iterable<CanonicalDealRecord>,
  account: string,
  symbol: string,
  ownedMagics: ReadonlySet<number>,
): Set<string> {
  const positionIds = new Set<string>();

  for (const deal of deals) {
    if (
      deal.account === account &&
      deal.symbol === symbol &&
      deal.isTradingDeal === true &&
      ownedMagics.has(Number(deal.magic))
    ) {
      positionIds.add(deal.positionId);
    }
  }

  return positionIds;
}

function canonicalizeDeal(
  account: string,
  deal: Mt5BridgeDeal,
): CanonicalDealRecord {
  const ticket = requireText(deal?.ticket, "ticket");
  const profit = finiteNumber(deal?.profit);
  const commission = finiteNumber(deal?.commission);
  const swap = finiteNumber(deal?.swap);
  const fee = finiteNumber(deal?.fee);

  return {
    ...deal,
    account,
    ticket,
    profit,
    commission,
    swap,
    fee,
    netPnl: normalizeNumber(profit + commission + swap + fee),
  };
}

function sameCanonicalDeal(
  left: CanonicalDealRecord,
  right: CanonicalDealRecord,
): boolean {
  return (
    left.account === right.account &&
    left.ticket === right.ticket &&
    left.orderId === right.orderId &&
    left.positionId === right.positionId &&
    left.symbol === right.symbol &&
    left.side === right.side &&
    left.entry === right.entry &&
    left.volume === right.volume &&
    left.price === right.price &&
    left.profit === right.profit &&
    left.commission === right.commission &&
    left.swap === right.swap &&
    left.fee === right.fee &&
    left.netPnl === right.netPnl &&
    left.magic === right.magic &&
    left.comment === right.comment &&
    left.timestamp === right.timestamp &&
    left.isTradingDeal === right.isTradingDeal
  );
}

function dealIdentity(account: string, ticket: string): string {
  return `${account}\u0000${ticket}`;
}

function compareDeals(
  left: CanonicalDealRecord,
  right: CanonicalDealRecord,
): number {
  return (
    Number(left.timestamp) - Number(right.timestamp) ||
    left.ticket.localeCompare(right.ticket) ||
    left.account.localeCompare(right.account)
  );
}

function finiteNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function normalizeNumber(value: number): number {
  return Math.round((value + Number.EPSILON) * 1e10) / 1e10;
}

function requireText(value: unknown, field: string): string {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`CanonicalDealLedger ${field} is required`);
  }
  return text;
}
