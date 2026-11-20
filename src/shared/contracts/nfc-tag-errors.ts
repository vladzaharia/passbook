import { z } from 'zod';

/** Stable codes for tag refusals, shared by the server, the scanner and the console. */
export const TAG_ERROR_CODES = [
  'TAG_LOST',
  'TAG_SECURE_REQUIRED',
  'TAG_CHECK_FAILED',
  'TAG_ALREADY_ASSIGNED',
  'TAG_REQUEST_BUSY',
  'TAG_REQUEST_EXPIRED',
  'TAG_HELD_BY_OTHER',
  'TAG_NO_ACCOUNT',
  'TAG_RETIRED',
  'TAG_UID_RANDOM',
  'TAG_BINDING_LIMIT',
  'TAG_LIMIT',
  'TAG_ASSURANCE_LOW',
  'TAG_HOLDER_CHANGED',
  'SCANNER_OFFLINE',
  'TAG_UNDO_EXPIRED',
  'TAG_PASS_VOIDED',
  'TAG_PASS_REMOVED',
  'TAG_PASS_EXPIRED',
  'TAG_TYPE_MISMATCH',
  'TAG_TYPE_LIMIT',
  'TAG_USE_MISMATCH',
  'TAG_SECURE_NEEDS_TAP',
  'TAG_TYPE_SET',
  'TAG_TYPE_SYSTEM',
  'TAG_TYPE_SCOPE',
  'TAG_TYPED_OFF',
  'TAG_TYPE_CHOOSE',
] as const;
export const TagErrorCodeSchema = z.enum(TAG_ERROR_CODES);
