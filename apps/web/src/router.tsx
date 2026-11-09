import {
  Phase7BPatternCheckPage,
  Phase7CAccountRiskPage,
  Phase7CControlCenterShellPage,
  Phase7CMobileReadOnlyPage,
  PerformancePage,
  Phase7CBacktestEvaluatorPage,
  DeferredPage,
} from "./routing-pages";
import { createBrowserRouter, Navigate } from "react-router-dom";
import { DashboardLayout } from "./ui/DashboardLayout";
import { Phase7BDemoPage } from "./pages/Phase7BDemoPage";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <DashboardLayout />,
    children: [
      { index: true, element: <Phase7BDemoPage /> },
      { path: "phase7b-demo", element: <Navigate to="/" replace /> },
      {
        path: "phase7b-pattern-check",
        element: <DeferredPage><Phase7BPatternCheckPage /></DeferredPage>,
      },
      {
        path: "backtest",
        element: <DeferredPage><Phase7CBacktestEvaluatorPage /></DeferredPage>,
      },
      {
        path: "phase7b-ops",
        element: <DeferredPage><Phase7CAccountRiskPage /></DeferredPage>,
      },
      {
        path: "phase7c-control-center",
        element: <DeferredPage><Phase7CControlCenterShellPage /></DeferredPage>,
      },
      {
        path: "phase7c-mobile",
        element: <DeferredPage><Phase7CMobileReadOnlyPage /></DeferredPage>,
      },
      {
        path: "performance",
        element: <DeferredPage><PerformancePage /></DeferredPage>,
      },
      { path: "system", element: <Navigate to="/phase7b-ops" replace /> },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);
