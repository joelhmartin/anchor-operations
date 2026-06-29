import test from 'node:test';
import assert from 'node:assert/strict';
import { listAccountSummaries, listDataStreams, listKeyEvents } from '../connections/ga4/adminApi.js';

function fakeFetch(body) {
  return async (_url, _opts) => ({
    ok: true,
    json: async () => body,
    text: async () => JSON.stringify(body)
  });
}

function failFetch(status) {
  return async () => ({ ok: false, status, text: async () => 'Forbidden' });
}

const TOKEN = 'fake-token';

test('listAccountSummaries returns accountSummaries array', async () => {
  const fetchFn = fakeFetch({
    accountSummaries: [
      { account: 'accounts/123', displayName: 'Acme', propertySummaries: [] }
    ]
  });
  const accounts = await listAccountSummaries({ token: TOKEN, fetchFn });
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].account, 'accounts/123');
});

test('listAccountSummaries returns empty array when key absent', async () => {
  const fetchFn = fakeFetch({});
  const accounts = await listAccountSummaries({ token: TOKEN, fetchFn });
  assert.deepEqual(accounts, []);
});

test('listDataStreams returns dataStreams array', async () => {
  const fetchFn = fakeFetch({
    dataStreams: [
      { name: 'properties/456/dataStreams/789', displayName: 'Web', type: 'WEB_DATA_STREAM', webStreamData: { measurementId: 'G-ABCD1234' } }
    ]
  });
  const streams = await listDataStreams('456', { token: TOKEN, fetchFn });
  assert.equal(streams.length, 1);
  assert.equal(streams[0].webStreamData.measurementId, 'G-ABCD1234');
});

test('listKeyEvents returns keyEvents array', async () => {
  const fetchFn = fakeFetch({
    keyEvents: [
      { name: 'properties/456/keyEvents/1', eventName: 'generate_lead', countingMethod: 'ONCE_PER_EVENT' }
    ]
  });
  const events = await listKeyEvents('456', { token: TOKEN, fetchFn });
  assert.equal(events[0].eventName, 'generate_lead');
});

test('listAccountSummaries throws on non-OK response', async () => {
  await assert.rejects(
    () => listAccountSummaries({ token: TOKEN, fetchFn: failFetch(403) }),
    /GA4 Admin 403/
  );
});
