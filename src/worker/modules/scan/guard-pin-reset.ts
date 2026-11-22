import { ConflictError } from '../../platform/errors.ts';

const EXEMPT = /\/(?:session|branding\/logo|device|unpair|staff|staff\/pin)$/;

/** What a person who has not taken the new PIN the server set may still call: the session, the PIN itself, sign-in and out. */
export const pinResetExempt = (method: string, path: string) =>
  EXEMPT.test(path) && (method !== 'GET' || /\/(?:session|branding\/logo)$/.test(path));

export const pinResetRequired = () =>
  new ConflictError('Get your new PIN to continue.', 'STAFF_PIN_RESET_REQUIRED');
