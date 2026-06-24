import test from 'node:test';
import assert from 'node:assert/strict';
import { mdToHtml } from '../blog/markdown.js';

test('renders headings and paragraphs', () => {
  const html = mdToHtml('# Title\n\nHello **world**.');
  assert.match(html, /<h1[^>]*>Title<\/h1>/);
  assert.match(html, /<strong>world<\/strong>/);
});

test('empty input → empty string', () => {
  assert.equal(mdToHtml('').trim(), '');
});
