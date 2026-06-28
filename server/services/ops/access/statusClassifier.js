/** Pure status → color classification + audit rollup. */
const COLOR = {
  verified: 'green',
  degraded: 'yellow',
  missing: 'yellow',
  failed: 'red',
  error: 'red',
  skipped: 'gray'
};

export function classifyService(status) {
  return COLOR[status] || 'gray';
}

export function summarize(statuses = []) {
  const counts = { green: 0, yellow: 0, red: 0, gray: 0 };
  for (const s of statuses) counts[classifyService(s)] += 1;
  return counts;
}

export function rollupStatus(statuses = []) {
  const { red, yellow } = summarize(statuses);
  if (red > 0) return 'failed';
  if (yellow > 0) return 'degraded';
  return 'verified';
}
