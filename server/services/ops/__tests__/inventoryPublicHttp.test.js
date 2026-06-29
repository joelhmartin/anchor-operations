import test from 'node:test';
import assert from 'node:assert/strict';
import publicHttp from '../connections/providers/public_http.js';

const HTML = `
<html><head>
<script>(function(){'GTM-ABC123';})();</script>
<script>gtag('config','G-ABCDEF1');</script>
<script>fbq('init', '1234567890');</script>
</head><body>
<a href="/about">About</a>
<a href="https://acme.com/contact">Contact</a>
<a href="mailto:hi@acme.com">Email</a>
<form id="lead" action="/submit"></form>
</body></html>`;

test('public_http connector emits url/form/tracking_tag rows', async () => {
  const rows = await publicHttp.discoverInventory({
    clientUserId: 7,
    clients: {
      resolveUrl: async () => 'https://acme.com',
      httpFetch: async () => ({ status: 200, body: HTML })
    }
  });

  const urls = rows.filter((r) => r.object_type === 'url');
  assert.ok(urls.some((u) => u.external_id === 'https://acme.com'), 'homepage url present');
  assert.ok(urls.some((u) => u.external_id === 'https://acme.com/about'), 'relative link resolved');
  assert.ok(urls.some((u) => u.external_id === 'https://acme.com/contact'), 'absolute internal link present');
  assert.ok(!urls.some((u) => /mailto:/.test(u.external_id)), 'mailto links excluded');

  const form = rows.find((r) => r.object_type === 'form');
  assert.equal(form.external_id, 'lead');
  assert.equal(form.metadata.action, '/submit');

  const tags = rows.filter((r) => r.object_type === 'tracking_tag');
  assert.ok(tags.some((t) => t.metadata.id === 'GTM-ABC123'));
  assert.ok(tags.some((t) => t.metadata.id === 'G-ABCDEF1'));
  assert.ok(tags.some((t) => t.name === 'meta_pixel' && t.metadata.id === '1234567890'));
});

test('public_http connector returns [] when no website url resolves', async () => {
  const rows = await publicHttp.discoverInventory({ clientUserId: 7, clients: { resolveUrl: async () => null, httpFetch: async () => ({}) } });
  assert.deepEqual(rows, []);
});
