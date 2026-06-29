export function parseRows(response, metricNames) {
  if (!response || !response.rows || !response.rows.length) return [];
  const dimHeaders = (response.dimensionHeaders || []).map((h) => h.name);
  return response.rows.map((row) => {
    const dimensions = {};
    (row.dimensionValues || []).forEach((dv, i) => { dimensions[dimHeaders[i]] = dv.value; });
    const metrics = {};
    metricNames.forEach((name, i) => {
      metrics[name] = Number((row.metricValues || [])[i]?.value ?? 0);
    });
    return { dimensions, metrics };
  });
}

export function aggregateFirstRow(response, metricNames) {
  const rows = parseRows(response, metricNames);
  return rows[0]?.metrics ?? Object.fromEntries(metricNames.map((n) => [n, 0]));
}
