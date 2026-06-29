import { getAdminAccessToken, listAccountSummaries, listDataStreams, listKeyEvents } from './adminApi.js';

export async function discoverInventory(ctx = {}) {
  const { env = process.env, fetchFn = globalThis.fetch } = ctx;
  const token = ctx.token ?? await getAdminAccessToken({ env });

  const accounts = await listAccountSummaries({ token, fetchFn });
  const now = new Date().toISOString();
  const rows = [];

  for (const account of accounts) {
    rows.push({
      object_type: 'ga4_account',
      external_id: account.account,
      display_name: account.displayName || account.account,
      metadata: { account_id: account.account },
      discovered_at: now
    });

    for (const ps of account.propertySummaries || []) {
      const propertyId = ps.property;
      const numericId = propertyId.split('/').pop();

      rows.push({
        object_type: 'ga4_property',
        external_id: propertyId,
        display_name: ps.displayName || propertyId,
        metadata: {
          property_id: propertyId,
          property_type: ps.propertyType || null,
          account_id: account.account
        },
        discovered_at: now
      });

      // Sub-resource failures caught individually so a 403 on one property
      // does not abort the entire account walk.
      const streams = await listDataStreams(numericId, { token, fetchFn }).catch(() => []);
      for (const stream of streams) {
        rows.push({
          object_type: 'ga4_data_stream',
          external_id: stream.name,
          display_name: stream.displayName || stream.name,
          metadata: {
            property_id: propertyId,
            stream_type: stream.type || null,
            measurement_id: stream.webStreamData?.measurementId || null
          },
          discovered_at: now
        });
      }

      const keyEvents = await listKeyEvents(numericId, { token, fetchFn }).catch(() => []);
      for (const ke of keyEvents) {
        rows.push({
          object_type: 'ga4_key_event',
          external_id: ke.name,
          display_name: ke.eventName,
          metadata: {
            property_id: propertyId,
            event_name: ke.eventName,
            counting_method: ke.countingMethod || null
          },
          discovered_at: now
        });
      }
    }
  }

  return rows;
}
