import dotenv from 'dotenv';
import path from 'path';
import { existsSync } from 'fs';

const rootDir = process.cwd();

dotenv.config({
  path: path.resolve(rootDir, '.env.public'),
  override: false
});

dotenv.config({
  path: path.resolve(rootDir, '.env'),
  override: true
});

// Default GOOGLE_APPLICATION_CREDENTIALS to gcloud ADC path if not provided
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const defaultGcloudCreds = path.join(
    process.env.HOME || process.env.USERPROFILE || '',
    '.config',
    'gcloud',
    'application_default_credentials.json'
  );
  if (existsSync(defaultGcloudCreds)) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = defaultGcloudCreds;
  }
}

// Helpful local debug log (safe: does not print secrets)
if ((process.env.NODE_ENV || 'development') !== 'production') {
  const adcPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const exists = adcPath ? existsSync(adcPath) : false;
  // eslint-disable-next-line no-console
  console.log('[gcloud-auth]', {
    GOOGLE_APPLICATION_CREDENTIALS: adcPath || null,
    adc_exists: exists,
    GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT || null,
    VERTEX_PROJECT_ID: process.env.VERTEX_PROJECT_ID || null,
    GOOGLE_CLOUD_REGION: process.env.GOOGLE_CLOUD_REGION || null,
    VERTEX_LOCATION: process.env.VERTEX_LOCATION || null
  });
}
