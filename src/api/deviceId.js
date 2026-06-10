/**
 * Device ID Management
 *
 * Generates and persists a stable device identifier for trusted device recognition.
 * This allows the backend to skip MFA for remembered/trusted devices.
 *
 * HIPAA Compliance Note:
 * - The device ID is a random UUID, not tied to personal information
 * - It's stored in localStorage, which persists across sessions
 * - Users can clear it by clearing browser storage
 */

const DEVICE_ID_KEY = 'anchor_device_id';

/**
 * Generate a random UUID v4
 */
function generateUUID() {
  // Use crypto.randomUUID if available (modern browsers)
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  // Fallback for older browsers
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Get the stable device ID, creating one if it doesn't exist
 */
export function getDeviceId() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }

  let deviceId = localStorage.getItem(DEVICE_ID_KEY);

  if (!deviceId) {
    deviceId = generateUUID();
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
  }

  return deviceId;
}

/**
 * Clear the device ID (useful for "forget this device" functionality)
 */
export function clearDeviceId() {
  if (typeof window !== 'undefined' && window.localStorage) {
    localStorage.removeItem(DEVICE_ID_KEY);
  }
}
