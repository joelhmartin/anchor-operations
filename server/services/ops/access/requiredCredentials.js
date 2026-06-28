/**
 * Per-service agency credential env-var requirements.
 * Names are authoritative against .env.example. Values are NEVER read here —
 * only presence is checked downstream. `anyOf` means at least one must be set.
 */
export const REQUIRED_CREDENTIALS = {
  core:           { required: ['ENCRYPTION_KEY', 'JWT_SECRET', 'DATABASE_URL'] },
  vertex:         { required: ['GOOGLE_CLOUD_PROJECT'] },
  google_ads:     { required: ['GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_REFRESH_TOKEN', 'GOOGLE_ADS_MANAGER_ID', 'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET'] },
  meta:           { required: ['FACEBOOK_SYSTEM_USER_TOKEN'] },
  kinsta:         { required: ['KINSTA_API_KEY'], optional: ['KINSTA_USER', 'KINSTA_USER_PASSWORD', 'KINSTA_AGENCY_ID'] },
  ctm:            { required: ['CTM_API_KEY', 'CTM_API_SECRET'] },
  ga4:            { anyOf: ['GA4_SERVICE_ACCOUNT_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'] },
  search_console: { anyOf: ['GA4_SERVICE_ACCOUNT_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'] },
  mailgun:        { required: ['MAILGUN_API_KEY', 'MAILGUN_DOMAIN'] },
  anthropic:      { required: ['ANTHROPIC_API_KEY'] }
};
