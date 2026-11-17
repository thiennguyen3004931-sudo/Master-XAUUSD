import { Alert, CircularProgress, Stack } from "@mui/material";

export function LoadingState() {
  return <Stack minHeight={320} alignItems="center" justifyContent="center"><CircularProgress /></Stack>;
}

export function ErrorState({ message }: { message: string }) {
  return <Alert severity="error">{message}</Alert>;
}
