export function Sparkline({
  values,
  positive = true,
  height = 220,
}: {
  values: number[];
  positive?: boolean;
  height?: number;
}) {
  const width = 900;
  const padding = 16;
  if (values.length < 2) {
    return <div style={{ height }} className="empty-state">Chưa đủ dữ liệu</div>;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 0.0001);
  const points = values.map((value, index) => ({
    x: padding + (index / (values.length - 1)) * (width - padding * 2),
    y: padding + ((max - value) / range) * (height - padding * 2),
  }));
  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
  const stroke = positive ? "#32d583" : "#f97066";

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="sparkline" role="img">
      {[0.25, 0.5, 0.75].map((ratio) => (
        <line
          key={ratio}
          x1={padding}
          x2={width - padding}
          y1={height * ratio}
          y2={height * ratio}
          stroke="rgba(148,163,184,.12)"
          strokeDasharray="4 8"
        />
      ))}
      <path d={path} fill="none" stroke={stroke} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
