import { useEffect, useState } from "react";

export function useLocalDay(): Date {
  const [day, setDay] = useState(() => ({
    date: new Date(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    offset: new Date().getTimezoneOffset(),
  }));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      const now = new Date();
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const offset = now.getTimezoneOffset();
      setDay((previous) =>
        previous.date.toDateString() === now.toDateString() &&
        previous.timeZone === timeZone &&
        previous.offset === offset
          ? previous
          : { date: now, timeZone, offset },
      );
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      if (timer !== undefined) globalThis.clearTimeout(timer);
      timer = globalThis.setTimeout(refresh, Math.min(next.getTime() - now.getTime(), 60_000));
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      if (timer !== undefined) globalThis.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return day.date;
}
