import PropTypes from 'prop-types';
import { Box, Typography } from '@mui/material';
import dayjs from 'dayjs';

const MIN_HEIGHT = { compact: 60, comfortable: 100 };

function defaultRenderEvent(event) {
  return (
    <Box
      role="button"
      tabIndex={-1}
      aria-label={event.title}
      sx={{
        px: 0.75,
        py: 0.25,
        borderRadius: 0.75,
        bgcolor: event.color || 'primary.light',
        color: 'text.primary',
        fontSize: '0.75rem',
        lineHeight: 1.3,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        cursor: 'pointer',
        '&:hover': { filter: 'brightness(0.95)' }
      }}
    >
      {event.title}
    </Box>
  );
}

export default function CalendarDay({ date, events, inMonth, density, maxEvents, onDayClick, onEventClick, renderEvent, dayIndex }) {
  const isToday = date.isSame(dayjs(), 'day');
  const visible = events.slice(0, maxEvents);
  const overflow = events.length - visible.length;
  const render = renderEvent || defaultRenderEvent;

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onDayClick?.(date.toDate());
    }
  };

  return (
    <Box
      role="gridcell"
      tabIndex={0}
      data-day-index={dayIndex}
      aria-label={date.format('dddd, MMMM D, YYYY')}
      onClick={() => onDayClick?.(date.toDate())}
      onKeyDown={handleKeyDown}
      sx={{
        minHeight: MIN_HEIGHT[density] || MIN_HEIGHT.comfortable,
        p: 0.75,
        borderRight: '1px solid',
        borderBottom: '1px solid',
        borderColor: 'divider',
        opacity: inMonth ? 1 : 0.4,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
        outline: 'none',
        '&:focus-visible': {
          boxShadow: (theme) => `inset 0 0 0 2px ${theme.palette.primary.main}`
        },
        '&:hover': { bgcolor: 'action.hover' }
      }}
    >
      <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Box
          sx={{
            width: 24,
            height: 24,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '50%',
            bgcolor: isToday ? 'primary.main' : 'transparent',
            color: isToday ? 'primary.contrastText' : 'text.primary',
            fontSize: '0.8rem',
            fontWeight: isToday ? 600 : 500
          }}
        >
          {date.date()}
        </Box>
      </Box>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25, minWidth: 0 }}>
        {visible.map((ev) => (
          <Box
            key={ev.id}
            onClick={(e) => {
              e.stopPropagation();
              onEventClick?.(ev);
            }}
            sx={{ minWidth: 0 }}
          >
            {render(ev)}
          </Box>
        ))}
        {overflow > 0 && (
          <Typography variant="caption" sx={{ color: 'text.secondary', pl: 0.5 }}>
            +{overflow} more
          </Typography>
        )}
      </Box>
    </Box>
  );
}

CalendarDay.propTypes = {
  date: PropTypes.object.isRequired,
  events: PropTypes.array.isRequired,
  inMonth: PropTypes.bool.isRequired,
  density: PropTypes.oneOf(['compact', 'comfortable']).isRequired,
  maxEvents: PropTypes.number.isRequired,
  onDayClick: PropTypes.func,
  onEventClick: PropTypes.func,
  renderEvent: PropTypes.func,
  dayIndex: PropTypes.number.isRequired
};
