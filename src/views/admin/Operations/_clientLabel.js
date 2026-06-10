/**
 * Canonical client label for dropdowns/selectors across the Operations tabs.
 *
 * Every client has an "informal business name" (`client_identifier_value`).
 * Fall back through the same chain AdminHub.jsx uses, ending at email/id so
 * we never render a blank option.
 */
export function clientLabel(c) {
  if (!c) return '';
  return c.client_identifier_value || c.client_label || c.business_name || c.name || c.first_name || c.email || c.id || '';
}
