import test from 'node:test';
import assert from 'node:assert/strict';
import { shellQuote, wpCreateArgs, wpMediaArgs, wpPublishArgs, imageExtFor } from '../blog/sshPublisher.js';

test('shellQuote single-quotes and escapes embedded quotes — injection-safe', () => {
  assert.equal(shellQuote('hello'), "'hello'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  // A shell-metacharacter payload stays fully inside the single quotes (no break-out):
  const q = shellQuote("x'; rm -rf / #");
  assert.ok(q.startsWith("'") && q.endsWith("'"));
  assert.ok(q.includes("'\\''")); // the embedded quote is escaped
});

test('wpCreateArgs builds a draft create with quoted title + file content', () => {
  const a = wpCreateArgs('/tmp/ops-blog-7.html', "Bob's Post");
  assert.ok(a.startsWith('post create /tmp/ops-blog-7.html '));
  assert.ok(a.includes("--post_title='Bob'\\''s Post'"));
  assert.ok(a.includes('--post_status=draft'));
  assert.ok(a.includes('--porcelain'));
});

test('wpMediaArgs / wpPublishArgs', () => {
  assert.equal(wpMediaArgs('/tmp/ops-blog-7-img', '42'), 'media import /tmp/ops-blog-7-img --post_id=42 --featured_image --porcelain');
  assert.equal(wpPublishArgs('42'), 'post update 42 --post_status=publish --porcelain');
});

test('imageExtFor — resolves extension from filename (case-insensitive, jpeg→jpg)', () => {
  assert.equal(imageExtFor('hero.PNG', null), '.png');
  assert.equal(imageExtFor('photo.JPEG', null), '.jpg');
  assert.equal(imageExtFor('anim.gif', null), '.gif');
  assert.equal(imageExtFor('banner.webp', null), '.webp');
});

test('imageExtFor — falls back to content_type when filename has no known extension', () => {
  assert.equal(imageExtFor('x', 'image/jpeg'), '.jpg');
  assert.equal(imageExtFor('x', 'image/png'), '.png');
  assert.equal(imageExtFor('x', 'image/gif'), '.gif');
  assert.equal(imageExtFor('x', 'image/webp'), '.webp');
});

test('imageExtFor — returns null for unrecognised types', () => {
  assert.equal(imageExtFor('x', 'application/pdf'), null);
  assert.equal(imageExtFor(null, null), null);
  assert.equal(imageExtFor('document.pdf', 'application/pdf'), null);
});
