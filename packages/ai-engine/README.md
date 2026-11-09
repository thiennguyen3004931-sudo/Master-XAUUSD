# @xauusd/ai-engine

Risk-constrained AI review layer for XAUUSD AI MASTER.

## Purpose

Pack 11 receives the completed outputs from:

- Analysis Engine
- Indicators
- Signal Engine
- Risk Engine
- Strategy Engine
- Optional Backtest metrics
- Optional recent performance metrics

It converts those outputs into a compact feature vector, requests one or more structured AI opinions, validates the JSON, builds a consensus, applies a conservative policy, records an audit trail, and returns a final advisory decision.

## Non-negotiable safety rules

AI may:

- confirm an existing risk-approved plan
- downgrade the plan to `WAIT`
- reject the plan

AI may not:

- convert `WAIT` or `REJECT` into `EXECUTE`
- bypass Risk Engine rejection
- increase volume
- move Stop Loss farther from entry
- modify the approved Entry, Stop Loss or Take Profit
- place an MT5 order directly

The final executable order is always copied from `RiskAssessment.order`.

## Offline default

Use the deterministic provider first:

```ts
import {
  AiDecisionEngine,
  DeterministicHeuristicProvider
} from "@xauusd/ai-engine";

const engine = new AiDecisionEngine([
  new DeterministicHeuristicProvider()
]);

const decision = await engine.review(context);
```

This mode has no network dependency and is suitable for integration tests and deterministic backtests.

## Remote or local model provider

`JsonHttpAiProvider` is provider-neutral:

```ts
const provider = new JsonHttpAiProvider({
  id: "local-model",
  kind: "LOCAL",
  model: "xauusd-review-model",
  endpoint: "http://127.0.0.1:8080/review",
  headers: {
    authorization: `Bearer ${process.env.AI_API_KEY}`
  },
  extractContent: (body) => {
    const value = body as { content: string };
    return value.content;
  }
});
```

External providers are disabled by default:

```ts
allowExternalProviders: false
```

Enable them only after secrets, logging, data-retention and cost controls are configured.

## Ensemble review

```ts
const engine = new AiDecisionEngine(
  [providerA, providerB, deterministicFallback],
  {
    minimumProviderCount: 2,
    minimumAgreementRatio: 0.67,
    minimumOpinionConfidence: 70,
    failClosed: true
  }
);
```

Ties are resolved conservatively:

```text
REJECT > DOWNGRADE_TO_WAIT > CONFIRM
```

## Structured response

Providers must return one JSON object matching:

```ts
{
  schemaVersion: "1.0.0",
  action: "CONFIRM" | "DOWNGRADE_TO_WAIT" | "REJECT",
  confidence: 0..100,
  marketQualityScore: 0..100,
  executionQualityScore: 0..100,
  riskQualityScore: 0..100,
  reasons: string[],
  warnings: string[],
  invalidationConditions: string[],
  featureContributions: Array<{
    feature: string,
    impact: -100..100,
    direction: "SUPPORT" | "OPPOSE" | "NEUTRAL",
    explanation: string
  }>
}
```

Malformed responses are rejected. When all providers fail, the default policy is fail-closed.

## Audit, dataset and drift

Pack 11 includes:

- `InMemoryAiAuditRepository`
- `AiDatasetExporter`
- `AiDriftMonitor`
- `AiExplanationService`

The dataset exporter creates JSONL records that can later be labeled using actual backtest or live-trade outcomes.

## Build

```bash
pnpm --filter @xauusd/ai-engine typecheck
pnpm --filter @xauusd/ai-engine build
pnpm --filter @xauusd/ai-engine test
```

## Production note

An AI confirmation is not proof of profitability. The Strategy and Risk Engines remain authoritative. AI should be evaluated in shadow mode, backtested, walk-forward tested and monitored for feature drift before it is allowed to influence demo execution.
