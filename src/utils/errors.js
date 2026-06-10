export function getErrorMessage(err, fallback = 'Something went wrong') {
  if (!err) return fallback;

  // Axios-style error payloads
  const resp = err?.response;
  const data = resp?.data;
  const fromAxios =
    (typeof data === 'string' && data) ||
    data?.message ||
    data?.error ||
    data?.detail ||
    (Array.isArray(data?.errors) && data.errors.map((e) => e?.message || e).filter(Boolean).join(', '));
  if (fromAxios) return String(fromAxios);

  // Native Error / generic
  if (err?.message) return String(err.message);

  try {
    return String(err);
  } catch {
    return fallback;
  }
}


