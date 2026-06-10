/**
 * Website umbrella check registrations — Phase 3.
 *
 * Importing this module triggers registerCheck() side-effects for every
 * website check. Imported by `server/services/ops/index.js` so any code path
 * that reaches into the ops barrel (run executor, routes/ops.js) ensures the
 * registry is populated before dispatch.
 */

import './ssl.js';
import './uptime.js';
import './trackingInstall.js';
import './schema.js';
import './psi.js';
import './gsc.js';
import './semrush.js';
import './brokenLinks.js';
import './kinstaDrift.js';
