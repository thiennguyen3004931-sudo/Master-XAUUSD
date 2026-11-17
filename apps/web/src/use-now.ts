import { useEffect, useState } from "react";

// Rendering uses a sampled clock; action handlers still check the actual deadline.
export function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
