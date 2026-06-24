export function parseVimeoId(input) {
  if (typeof input !== 'string') return null;
  const m = input.match(/(?:vimeo\.com\/(?:video\/)?|^)(\d{6,})/);
  return m ? m[1] : null;
}
