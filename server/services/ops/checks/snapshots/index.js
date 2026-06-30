/**
 * Snapshot/baseline umbrella check registrations (V5).
 *
 * Importing this module triggers registerCheck() side-effects for the
 * snapshot-anomaly check. Imported by runExecutor.js so the registry is
 * populated before any run dispatch.
 */

import './metricAnomaly.js';
