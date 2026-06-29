import test from 'node:test';
import assert from 'node:assert/strict';
import { matchProperty, propertyType } from '../connections/gsc/propertyMatcher.js';

const SITES = [
  { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
  { siteUrl: 'https://www.example.com/', permissionLevel: 'siteFullUser' },
  { siteUrl: 'https://example.com/', permissionLevel: 'siteRestrictedUser' }
];

test('exact_config wins when exactConfig matches a site in the list', () => {
  const r = matchProperty('https://www.example.com', SITES, 'https://www.example.com/');
  assert.equal(r.matchType, 'exact_config');
  assert.equal(r.siteUrl, 'https://www.example.com/');
  assert.equal(r.confidence, 1.0);
});

test('exact_config falls through when configured URL is not in the site list', () => {
  const r = matchProperty('https://www.example.com', SITES, 'https://staging.example.com/');
  assert.equal(r.matchType, 'sc_domain');
});

test('sc-domain preferred over url-prefix variants', () => {
  const r = matchProperty('https://www.example.com', SITES);
  assert.equal(r.matchType, 'sc_domain');
  assert.equal(r.siteUrl, 'sc-domain:example.com');
  assert.equal(r.confidence, 0.95);
  assert.equal(r.permissionLevel, 'siteOwner');
});

test('url_prefix_https_www when no sc-domain present', () => {
  const sites = [{ siteUrl: 'https://www.example.com/', permissionLevel: 'siteOwner' }];
  const r = matchProperty('https://www.example.com', sites);
  assert.equal(r.matchType, 'url_prefix_https_www');
  assert.equal(r.siteUrl, 'https://www.example.com/');
  assert.equal(r.confidence, 0.9);
});

test('url_prefix_https (no www) when www variant absent', () => {
  const sites = [{ siteUrl: 'https://example.com/', permissionLevel: 'siteFullUser' }];
  const r = matchProperty('https://www.example.com', sites);
  assert.equal(r.matchType, 'url_prefix_https');
  assert.equal(r.confidence, 0.85);
});

test('url_prefix_http www variant', () => {
  const sites = [{ siteUrl: 'http://www.example.com/', permissionLevel: 'siteOwner' }];
  const r = matchProperty('https://www.example.com', sites);
  assert.equal(r.matchType, 'url_prefix_http');
  assert.equal(r.confidence, 0.7);
});

test('url_prefix_http naked domain', () => {
  const sites = [{ siteUrl: 'http://example.com/', permissionLevel: 'siteOwner' }];
  const r = matchProperty('https://example.com', sites);
  assert.equal(r.matchType, 'url_prefix_http');
  assert.equal(r.confidence, 0.7);
});

test('manual when no sites match', () => {
  const r = matchProperty('https://www.example.com', []);
  assert.equal(r.matchType, 'manual');
  assert.equal(r.siteUrl, null);
  assert.equal(r.confidence, 0);
});

test('invalid websiteUrl degrades to manual', () => {
  const r = matchProperty('not-a-url', SITES);
  assert.equal(r.matchType, 'manual');
});

test('propertyType classifies sc-domain and url-prefix', () => {
  assert.equal(propertyType('sc-domain:example.com'), 'domain');
  assert.equal(propertyType('https://www.example.com/'), 'url_prefix');
  assert.equal(propertyType('http://example.com/'), 'url_prefix');
});
