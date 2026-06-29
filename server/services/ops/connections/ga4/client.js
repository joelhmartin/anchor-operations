import { BetaAnalyticsDataClient } from '@google-analytics/data';

export function buildGa4Client({ env = process.env, ga4Client = null } = {}) {
  if (ga4Client) return ga4Client;

  const keyJson = env.GA4_SERVICE_ACCOUNT_KEY;
  if (keyJson) {
    let credentials;
    try {
      credentials = JSON.parse(keyJson);
    } catch (e) {
      throw new Error(`GA4: GA4_SERVICE_ACCOUNT_KEY is not valid JSON — ${e.message}`);
    }
    return new BetaAnalyticsDataClient({ credentials });
  }

  return new BetaAnalyticsDataClient();
}
