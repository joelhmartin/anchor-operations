/**
 * F2 inventory connectors. F1's connection registry imports this array and
 * merges the remaining contract methods (verifyConnection / collectSnapshot /
 * listCapabilities / actions / checks) onto each module.
 */
import kinsta from './kinsta.js';
import wordpress from './wordpress.js';
import publicHttp from './public_http.js';
import googleAds from './google_ads.js';
import meta from './meta.js';
import ctm from './ctm.js';
import ga4 from '../ga4/index.js';
import gsc from '../gsc/index.js';

// F9 connectors — side-effect imports trigger self-registration in the F1 connector registry.
import '../monday/index.js';
import '../github/index.js';
import '../vercel/index.js';
import '../gtm/index.js';
import '../gbp/index.js';

export const INVENTORY_CONNECTORS = [kinsta, wordpress, publicHttp, googleAds, meta, ctm, ga4, gsc];

export default INVENTORY_CONNECTORS;
