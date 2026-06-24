import { useEffect, useMemo, useState } from 'react';
import { Chip } from '@mui/material';
import MainCard from 'ui-component/cards/MainCard';
import Calendar from 'ui-component/extended/Calendar';
import { listPosts } from 'api/social';

const STATUS_COLOR = {
  scheduled: 'info.light',
  published: 'success.light',
  partially_published: 'warning.light',
  failed: 'error.light',
  draft: 'grey.300',
  cancelled: 'grey.200',
  publishing: 'info.main'
};

export default function CalendarView({ refreshKey = 0, onEventClick, onDayClick }) {
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState(null);

  useEffect(() => {
    if (!range) return;
    setLoading(true);
    listPosts({ from: range.from, to: range.to })
      .then(setPosts)
      .catch(() => setPosts([]))
      .finally(() => setLoading(false));
  }, [range, refreshKey]);

  const handleNavigate = (start, end) => setRange({ from: start.toISOString(), to: end.toISOString() });

  const events = useMemo(
    () =>
      posts
        .filter((p) => p.scheduled_for || p.published_at)
        .map((p) => ({
          id: p.id,
          date: p.scheduled_for || p.published_at,
          title: (p.content || '(media-only)').slice(0, 40),
          color: STATUS_COLOR[p.status],
          meta: p
        })),
    [posts]
  );

  return (
    <MainCard title="Calendar">
      <Calendar
        events={events}
        loading={loading}
        onNavigate={handleNavigate}
        onEventClick={(ev) => onEventClick?.(ev.meta)}
        onDayClick={(date) => onDayClick?.(date)}
        renderEvent={(ev) => (
          <Chip
            size="small"
            label={ev.title}
            sx={{
              width: '100%',
              justifyContent: 'flex-start',
              bgcolor: ev.color || 'primary.light',
              height: 20,
              fontSize: 11,
              '& .MuiChip-label': { px: 0.75 }
            }}
          />
        )}
      />
    </MainCard>
  );
}
