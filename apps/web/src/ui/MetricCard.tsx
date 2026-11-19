import type { ReactNode } from "react";
import { Card, CardContent, Stack, Typography } from "@mui/material";

export function MetricCard({
  label,
  value,
  detail,
  icon,
  tone = "text.primary",
}: {
  label: string;
  value: string;
  detail?: string;
  icon?: ReactNode;
  tone?: string;
}) {
  return (
    <Card>
      <CardContent>
        <Stack direction="row" justifyContent="space-between" gap={2}>
          <Typography variant="caption" color="text.secondary">
            {label}
          </Typography>
          {icon}
        </Stack>
        <Typography
          variant="h5"
          sx={{ mt: 1.5, fontWeight: 800, color: tone, letterSpacing: "-.03em" }}
        >
          {value}
        </Typography>
        {detail ? (
          <Typography variant="caption" color="text.secondary">
            {detail}
          </Typography>
        ) : null}
      </CardContent>
    </Card>
  );
}
