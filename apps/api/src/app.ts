import express, { type Request, type Response } from "express";
import cors from "cors";
import healthRouter from "./routes/health.route";
import marketRouter from "./routes/market.route";
import dashboardRouter from "./routes/dashboard.route";
import backtestRouter from "./routes/backtest.route";
import controlRouter from "./routes/control.route";
import systemRouter from "./routes/system.route";
import mt5Router from "./routes/mt5.route";
import soakRouter from "./routes/soak.route";
import phase7bDemoRouter from "./routes/phase7b-demo.route";
import phase7bPatternCheckRouter from "./routes/phase7b-pattern-check.route";
import phase7bOpsRouter from "./routes/phase7b-ops.route";
import phase7bTelegramTestRouter from "./routes/phase7b-telegram-test.route";
import phase7cRouter from "./routes/phase7c.route";
import phase7cRuntimeSourceAttestationRouter from "./routes/phase7c-runtime-source-attestation.route";
import phase7cCanonicalDealLedgerRouter from "./routes/phase7c-canonical-deal-ledger.route";
import phase7cAccountSwitchRouter from "./routes/phase7c-account-switch.route";
import phase7cAutoActivationRouter from "./routes/phase7c-auto-activation.route";
import phase7cLiveArmControlRouter from "./routes/phase7c-live-arm-control.route";
import phase7cPerformanceIntelligenceRouter from "./routes/phase7c-performance-intelligence.route";
import phase7cPerformanceEffectivenessRouter from "./routes/phase7c-performance-effectiveness.route";
import phase7cCounterfactualIntelligenceRouter from "./routes/phase7c-counterfactual-intelligence.route";
import phase7cRecommendationIntelligenceRouter from "./routes/phase7c-recommendation-intelligence.route";
import phase7cPatternAdvisorRouter from "./routes/phase7c-pattern-advisor.route";
import phase7cBacktestEvaluatorRouter from "./routes/phase7c-backtest-evaluator.route";
import phase7cChartRouter from "./routes/phase7c-chart.route";
import phase7cUiRouter from "./routes/phase7c-ui.route";
import phase7dRouter from "./routes/phase7d.route";
import phase7eRouter from "./routes/phase7e.route";

const app = express();

app.disable("x-powered-by");
app.use(
  cors({
    origin: process.env.WEB_ORIGIN?.split(",").map((item) => item.trim()) ?? true,
    credentials: false,
  }),
);
app.use(express.json({ limit: "256kb" }));

app.use("/api/v1/health", healthRouter);
app.use("/api/v1/market", marketRouter);
app.use("/api/v1/dashboard", dashboardRouter);
app.use("/api/v1/backtest", backtestRouter);
app.use("/api/v1/control", controlRouter);
app.use("/api/v1/system", systemRouter);
app.use("/api/v1/mt5", mt5Router);
app.use("/api/v1/soak", soakRouter);
app.use("/api/v1/phase7b-demo", phase7bDemoRouter);
app.use("/api/v1/phase7b-pattern-check", phase7bPatternCheckRouter);
app.use("/api/v1/phase7b-ops", phase7bOpsRouter);
app.use("/api/v1/phase7b-telegram-test", phase7bTelegramTestRouter);
app.use("/api/v1/phase7c/runtime-source-attestation", phase7cRuntimeSourceAttestationRouter);
app.use("/api/v1/phase7c", phase7cRouter);
app.use("/api/v1/phase7c-canonical-ledger", phase7cCanonicalDealLedgerRouter);
app.use("/api/v1/phase7c-account-switch", phase7cAccountSwitchRouter);
app.use("/api/v1/phase7c-auto-activation", phase7cAutoActivationRouter);
app.use("/api/v1/phase7c-live-arm-control", phase7cLiveArmControlRouter);
app.use("/api/v1/phase7c/performance-intelligence", phase7cPerformanceIntelligenceRouter);
app.use("/api/v1/phase7c/performance-effectiveness", phase7cPerformanceEffectivenessRouter);
app.use("/api/v1/phase7c/counterfactual-intelligence", phase7cCounterfactualIntelligenceRouter);
app.use("/api/v1/phase7c/recommendation-intelligence", phase7cRecommendationIntelligenceRouter);
app.use("/api/v1/phase7c/pattern-advisor", phase7cPatternAdvisorRouter);
app.use("/api/v1/phase7c/backtest-evaluator", phase7cBacktestEvaluatorRouter);
app.use("/api/v1/phase7c-chart", phase7cChartRouter);
app.use("/api/v1/phase7c-ui", phase7cUiRouter);
app.use("/api/v1/phase7d", phase7dRouter);
app.use("/api/v1/phase7e", phase7eRouter);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Route not found." });
});

export default app;
