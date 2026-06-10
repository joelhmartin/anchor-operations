/**
 * Google Ads umbrella check registrations — Phase 4.
 *
 * Importing this module triggers registerCheck() side-effects for every
 * google_ads check. Imported by `server/services/ops/index.js` and
 * `server/services/ops/runExecutor.js` so the registry is populated before
 * any run dispatch.
 */

import './conversionTracking.js';
import './negativeKeywords.js';
import './accountConfig.js';
import './keywordHistory.js';
import './suggested.js';
