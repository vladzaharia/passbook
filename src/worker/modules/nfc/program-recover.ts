import type { TagProgramErrorCode } from '../../../shared/contracts/nfc-tag-programs.ts';
import { SCAN_TAG_PROGRAM_COPY } from '../../../shared/copy/scan-tag-program.ts';
import { AppError } from '../../platform/errors.ts';
import { Ntag424Error, ZERO16 } from './ntag424/bytes.ts';

/** A hold lasts a minute from the call that opened it (the design's session TTL). */
export const HOLD_TTL_MS = 60_000;

/**
 * Auth part 2 messages released for one tag, across holds: each costs the tag a failed-auth count if the key is
 * wrong (TotFailCtrLimit 1000 bricks key 0). A hold tries at most two keys, so this is three holds.
 */
export const ATTEMPT_CAP = 6;

const STATUS: Record<TagProgramErrorCode, number> = {
  TAG_MOVED: 409,
  TAG_NOT_BLANK: 409,
  TAG_NOT_424: 422,
  TAG_KNOWN: 409,
  TAG_NOT_GENUINE: 422,
  TAG_PROGRAM_BUSY: 409,
  TAG_PROGRAM_EXPIRED: 410,
  TAG_PROGRAM_FAILED: 409,
  TAG_PROGRAM_RATE_LIMITED: 429,
  KEYSET_NOT_PROGRAMMABLE: 409,
};

/** The refusal a device is shown. It never carries a UID, key, APDU or response. */
export const programError = (code: TagProgramErrorCode): AppError =>
  new AppError(code, STATUS[code], SCAN_TAG_PROGRAM_COPY.failed[code]);

/**
 * `Ntag424Error` never reaches HTTP: here it becomes the code the device understands. A refused command or a
 * short answer is a tag that left the field; a bad MAC or a malformed answer is a failure the device cannot fix.
 */
export function mapNtag(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (!(error instanceof Ntag424Error)) throw error;
  switch (error.code) {
    case 'NTAG_UNSUPPORTED':
      return programError('TAG_NOT_424');
    case 'NTAG_COMMAND_FAILED':
      return programError('TAG_MOVED');
    default:
      return programError('TAG_PROGRAM_FAILED');
  }
}

/**
 * The keys now in slots 1 to 4 from the probe's GetKeyVersion answers: version 00 is the factory key, the
 * row's own version is the intended key (the change went through), anything else is a key the server does not
 * hold, and the tag is not ours to continue. Null in that case.
 */
export function oldKeysFromProbe(
  bodies: Uint8Array[],
  keys: Uint8Array[],
  version: number,
): Uint8Array[] | null {
  const old: Uint8Array[] = [];
  for (let n = 1; n <= 4; n++) {
    const v = bodies[n - 1];
    if (v?.length !== 1) return null;
    if (v[0] === 0) old.push(ZERO16);
    else if (v[0] === version) old.push(keys[n] as Uint8Array);
    else return null;
  }
  return old;
}
