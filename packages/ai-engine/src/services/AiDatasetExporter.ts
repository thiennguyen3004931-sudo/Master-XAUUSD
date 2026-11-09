import type { BacktestTrade } from "@xauusd/backtest-engine";
import type {
  AiAction,
  AiDatasetRecord,
  AiFeatureVector
} from "../models";
import { IdFactory } from "../utils";

export class AiDatasetExporter {
  private readonly ids = new IdFactory();

  createUnlabeled(
    features: AiFeatureVector,
    aiAction?: AiAction
  ): AiDatasetRecord {
    return {
      recordId: this.ids.create(
        "dataset",
        features.generatedAt
      ),
      features: structuredClone(features),
      aiAction,
      createdAt: features.generatedAt
    };
  }

  label(
    record: AiDatasetRecord,
    trade: BacktestTrade
  ): AiDatasetRecord {
    return {
      ...record,
      label: {
        realizedRMultiple: trade.rMultiple,
        realizedNetPnl: trade.netPnl,
        profitable: trade.netPnl > 0,
        exitReason: trade.exitReason
      }
    };
  }

  toJsonLines(
    records: readonly AiDatasetRecord[]
  ): string {
    return records
      .map((record) => JSON.stringify(record))
      .join("\n");
  }
}
