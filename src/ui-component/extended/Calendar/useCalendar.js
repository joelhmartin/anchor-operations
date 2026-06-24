import { useMemo, useState, useCallback } from 'react';
import dayjs from 'dayjs';

export function useCalendar({ initialDate, view: initialView = 'month' }) {
  const [cursor, setCursor] = useState(() => dayjs(initialDate || undefined));
  const [view, setView] = useState(initialView);

  const range = useMemo(() => {
    const start = view === 'month' ? cursor.startOf('month').startOf('week') : cursor.startOf('week');
    const end = view === 'month' ? cursor.endOf('month').endOf('week') : cursor.endOf('week');
    const days = [];
    for (let d = start; d.isBefore(end) || d.isSame(end, 'day'); d = d.add(1, 'day')) days.push(d);
    return { start, end, days };
  }, [cursor, view]);

  const navigate = useCallback(
    (dir) => {
      setCursor((c) => {
        if (dir === 'today') return dayjs();
        if (view === 'month') return c.add(dir === 'next' ? 1 : -1, 'month');
        return c.add(dir === 'next' ? 1 : -1, 'week');
      });
    },
    [view]
  );

  return {
    cursor,
    view,
    setView,
    range,
    navigate,
    title: view === 'month' ? cursor.format('MMMM YYYY') : `${range.start.format('MMM D')} – ${range.end.format('MMM D, YYYY')}`
  };
}

export default useCalendar;
