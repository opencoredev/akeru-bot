import { useEffect, useState } from "react";

export function useLocalDay(): Date {
  const [day, setDay] = useState(() => new Date());

  useEffect(() => {
    let timer: number;
    const refresh = () => {
      const now = new Date();
      setDay((previous) => (previous.toDateString() === now.toDateString() ? previous : now));
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, Math.min(next.getTime() - now.getTime(), 60_000));
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return day;
}
