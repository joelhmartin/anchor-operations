import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false });

// Convert staff-authored markdown to HTML for the WordPress post body.
export function mdToHtml(md) {
  if (!md) return '';
  return marked.parse(String(md));
}
