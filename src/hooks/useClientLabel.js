import { useMemo } from 'react';

// Canonical client display name on the frontend.
//
// Mirrors the backend fallback chain (see server/services/clientLabel.js).
// Prefer `client_label` if the backend already emitted it; otherwise reconstruct
// from whatever fields the row happens to carry.
//
// Fallback order:
//   1. row.client_label             (backend canonical, when present)
//   2. row.client_identifier_value  (informal business name from client_profiles)
//   3. row.business_name            (from brand_assets — mostly NULL in prod)
//   4. row.first_name + ' ' + row.last_name
//   5. row.email
//   6. ''                           (empty rather than "undefined undefined")

function trimOrNull(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

export function clientLabel(row) {
  if (!row) return '';
  return (
    trimOrNull(row.client_label) ||
    trimOrNull(row.client_identifier_value) ||
    trimOrNull(row.business_name) ||
    trimOrNull(`${row.first_name || ''} ${row.last_name || ''}`) ||
    trimOrNull(row.email) ||
    ''
  );
}

export function useClientLabel(row) {
  return useMemo(() => clientLabel(row), [row]);
}

export function useClientLabels(rows) {
  return useMemo(() => {
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => ({ ...row, _label: clientLabel(row) }));
  }, [rows]);
}

export default useClientLabel;
