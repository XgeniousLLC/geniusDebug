/**
 * Re-export the shared AES-256-GCM helpers so the API encrypts secrets with the
 * exact same key/scheme the workers use to decrypt them (NFR-SEC-5).
 */
export { encrypt, decrypt } from '@geniusdebug/shared';
