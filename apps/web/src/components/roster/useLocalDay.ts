import { useEffect, useState } from "react";

export function useLocalDay(): Date {
  const [day, setDay] = useState(() => new Date());

  useEffect(() => {
    let timer: number;
    const schedule = () => {
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = window.setTimeout(() => {
        setDay(new Date());
        schedule();
      }, next.getTime() - now.getTime());
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, []);

  return day;
}
