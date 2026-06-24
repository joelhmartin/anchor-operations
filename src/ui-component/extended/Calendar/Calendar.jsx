import { useEffect, useMemo, useRef } from 'react';
import PropTypes from 'prop-types';
import { Box, Button, IconButton, Paper, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import dayjs from 'dayjs';

import CalendarDay from './CalendarDay';
import { useCalendar } from './useCalendar';

const WEEKDAYS = Array.from({ length: 7 }, (_, i) => dayjs().day(i).format('ddd'));

export default function Calendar({
  events = [],
  view = 'month',
  initialDate,
  density = 'comfortable',
  maxEventsPerDay = 3,
  onEventClick,
  onDayClick,
  onNavigate,
  renderEvent,
  loading = false
}) {
  const cal = useCalendar({ initialDate, view });
  const gridRef = useRef(null);

  const eventsByDay = useMemo(() => {
    const m = new Map();
    for (const ev of events) {
      const key = dayjs(ev.date).format('YYYY-MM-DD');
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(ev);
    }
    for (const arr of m.values()) arr.sort((a, b) => dayjs(a.date).valueOf() - dayjs(b.date).valueOf());
    return m;
  }, [events]);

  const rangeStartMs = cal.range.start.valueOf();
  const rangeEndMs = cal.range.end.valueOf();
  useEffect(() => {
    if (onNavigate) onNavigate(new Date(rangeStartMs), new Date(rangeEndMs));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeStartMs, rangeEndMs]);

  const handleGridKeyDown = (e) => {
    const active = document.activeElement;
    if (!active || !active.hasAttribute('data-day-index')) return;
    const idx = parseInt(active.getAttribute('data-day-index'), 10);
    const total = cal.range.days.length;
    let next = idx;
    if (e.key === 'ArrowLeft') next = idx - 1;
    else if (e.key === 'ArrowRight') next = idx + 1;
    else if (e.key === 'ArrowUp') next = idx - 7;
    else if (e.key === 'ArrowDown') next = idx + 7;
    else return;
    e.preventDefault();
    next = Math.max(0, Math.min(total - 1, next));
    const nextCell = gridRef.current?.querySelector(`[data-day-index="${next}"]`);
    if (nextCell) nextCell.focus();
  };

  return (
    <Paper
      variant="outlined"
      sx={{
        opacity: loading ? 0.5 : 1,
        transition: 'opacity 200ms ease',
        overflow: 'hidden'
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1,
          px: 2,
          py: 1.5,
          borderBottom: '1px solid',
          borderColor: 'divider'
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: '0 0 auto' }}>
          <IconButton size="small" aria-label="Previous" onClick={() => cal.navigate('prev')}>
            <ChevronLeftIcon fontSize="small" />
          </IconButton>
          <IconButton size="small" aria-label="Next" onClick={() => cal.navigate('next')}>
            <ChevronRightIcon fontSize="small" />
          </IconButton>
          <Button size="small" onClick={() => cal.navigate('today')}>
            Today
          </Button>
        </Box>

        <Typography variant="h6" sx={{ flex: 1, textAlign: 'center', fontWeight: 600 }}>
          {cal.title}
        </Typography>

        <Box sx={{ flex: '0 0 auto' }}>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={cal.view}
            onChange={(_, v) => {
              if (v) cal.setView(v);
            }}
            aria-label="Calendar view"
          >
            <ToggleButton value="month" aria-label="Month view">
              Month
            </ToggleButton>
            <ToggleButton value="week" aria-label="Week view">
              Week
            </ToggleButton>
          </ToggleButtonGroup>
        </Box>
      </Box>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          borderBottom: '1px solid',
          borderColor: 'divider',
          bgcolor: 'background.default'
        }}
      >
        {WEEKDAYS.map((label) => (
          <Typography
            key={label}
            variant="caption"
            align="center"
            sx={{ fontWeight: 600, color: 'text.secondary', py: 1, textTransform: 'uppercase', letterSpacing: 0.5 }}
          >
            {label}
          </Typography>
        ))}
      </Box>

      <Box
        ref={gridRef}
        role="grid"
        aria-label="Calendar"
        onKeyDown={handleGridKeyDown}
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gap: 0,
          borderLeft: '1px solid',
          borderTop: '1px solid',
          borderColor: 'divider'
        }}
      >
        {cal.range.days.map((d, i) => {
          const key = d.format('YYYY-MM-DD');
          const dayEvents = eventsByDay.get(key) || [];
          const inMonth = cal.view === 'week' ? true : d.isSame(cal.cursor, 'month');
          return (
            <CalendarDay
              key={key}
              date={d}
              events={dayEvents}
              inMonth={inMonth}
              density={density}
              maxEvents={maxEventsPerDay}
              onDayClick={onDayClick}
              onEventClick={onEventClick}
              renderEvent={renderEvent}
              dayIndex={i}
            />
          );
        })}
      </Box>
    </Paper>
  );
}

Calendar.propTypes = {
  events: PropTypes.array,
  view: PropTypes.oneOf(['month', 'week']),
  initialDate: PropTypes.oneOfType([PropTypes.instanceOf(Date), PropTypes.string, PropTypes.object]),
  density: PropTypes.oneOf(['compact', 'comfortable']),
  maxEventsPerDay: PropTypes.number,
  onEventClick: PropTypes.func,
  onDayClick: PropTypes.func,
  onNavigate: PropTypes.func,
  renderEvent: PropTypes.func,
  loading: PropTypes.bool
};
