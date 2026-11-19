import React from "react";
import ReactDOM from "react-dom/client";
import { CssBaseline, ThemeProvider, createTheme } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import "./styles.css";

// Suppress the legacy full-body localization observer before React renders.
// The scoped VietnameseLocalizationRuntime inside App owns dynamic translation.
document.body.setAttribute("data-no-vi-localize", "runtime-managed");

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 2_000,
      refetchOnWindowFocus: false,
    },
  },
});

const vietnameseFontFamily = [
  '"Segoe UI Variable"',
  '"Segoe UI"',
  '"Noto Sans"',
  'Arial',
  'sans-serif',
].join(", ");

const theme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: "#e9b949" },
    success: { main: "#32d583" },
    error: { main: "#f97066" },
    warning: { main: "#fdb022" },
    background: {
      default: "#060b14",
      paper: "#0b1220",
    },
    text: {
      primary: "#f8fafc",
      secondary: "#8fa0b8",
    },
  },
  shape: { borderRadius: 16 },
  typography: {
    fontFamily: vietnameseFontFamily,
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          fontFamily: vietnameseFontFamily,
          fontSynthesis: "none",
          textRendering: "optimizeLegibility",
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
          border: "1px solid rgba(148,163,184,.14)",
          boxShadow: "0 18px 48px rgba(0,0,0,.24)",
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: "none",
          fontWeight: 700,
          borderRadius: 12,
        },
      },
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <App />
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
