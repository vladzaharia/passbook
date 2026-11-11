import type { Mode } from '../../../shared/contracts/common.ts';
import type { ApiKeyAuth, SessionAuth } from '../../platform/auth.ts';
import { decryptSecret, type Envelope, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { ValidationError } from '../../platform/errors.ts';
import { fromBase64Url, toBase64Url } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanLogFilter } from './repo-feed.ts';

/** An internal keyset position, never an external cursor. */
export interface ScanCursorPosition {
  at: number;
  id: string;
}

export interface ConsoleCursorScope {
  auth: Pick<SessionAuth, 'kind' | 'userId' | 'sessionId'> | Pick<ApiKeyAuth, 'kind' | 'keyId'>;
  /** Null or undefined means a platform-wide feed. */
  orgId: string | null | undefined;
  mode: Mode;
  filters: Pick<
    ScanLogFilter,
    'q' | 'passId' | 'scannerId' | 'staffId' | 'eventId' | 'outcome' | 'reason' | 'from' | 'to'
  >;
  operation: 'list' | 'export';
}

type CursorContext = Pick<ServiceContext, 'env' | 'clock'>;

const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CURSOR_LENGTH = 512;
const MAX_ID_LENGTH = 64;
const TIMESTAMP_BYTES = 8;
const HEADER_BYTES = 3 * TIMESTAMP_BYTES;
const IV_BYTES = 12;
const WRAPPED_DEK_BYTES = 60;
const TAG_BYTES = 16;

const invalidCursor = () => new ValidationError('Invalid cursor.', [], 'INVALID_CURSOR');
const validTimestamp = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** JSON array boundaries avoid delimiter collisions; none of this data is sent to the client. */
function associatedData(scope: ConsoleCursorScope, kekVersion: number): string {
  const auth = scope.auth;
  const principal =
    auth.kind === 'session'
      ? ['user', auth.userId, 'session', auth.sessionId]
      : ['api_key', auth.keyId, 'api_key', auth.keyId];
  const f = scope.filters;
  return JSON.stringify([
    'scan-console-cursor-v1',
    kekVersion,
    scope.operation,
    ...principal,
    scope.orgId ?? null,
    scope.mode,
    f.q?.trim() || null,
    f.passId ?? null,
    f.scannerId ?? null,
    f.staffId ?? null,
    f.eventId ?? null,
    f.outcome ?? null,
    f.reason ?? null,
    f.from ?? null,
    f.to ?? null,
  ]);
}

/**
 * Three unsigned millisecond timestamps followed by the ID as UTF-16 code units. The latter
 * preserves every ID allowed by IdSchema, including control characters and unpaired surrogates,
 * while bounding the token even when JSON escaping or UTF-8 would expand the ID.
 */
function payload(position: ScanCursorPosition, issuedAt: number): Uint8Array {
  if (
    !validTimestamp(position.at) ||
    typeof position.id !== 'string' ||
    position.id.length === 0 ||
    position.id.length > MAX_ID_LENGTH ||
    !validTimestamp(issuedAt) ||
    !validTimestamp(issuedAt + CURSOR_TTL_MS)
  )
    throw new Error('Invalid scan cursor position or clock.');

  const bytes = new Uint8Array(HEADER_BYTES + position.id.length * 2);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, BigInt(position.at));
  view.setBigUint64(TIMESTAMP_BYTES, BigInt(issuedAt));
  view.setBigUint64(2 * TIMESTAMP_BYTES, BigInt(issuedAt + CURSOR_TTL_MS));
  for (let i = 0; i < position.id.length; i++) {
    view.setUint16(HEADER_BYTES + i * 2, position.id.charCodeAt(i));
  }
  return bytes;
}

function positionFromPayload(bytes: Uint8Array, now: number): ScanCursorPosition {
  const idBytes = bytes.length - HEADER_BYTES;
  if (idBytes < 2 || idBytes > MAX_ID_LENGTH * 2 || idBytes % 2 !== 0) throw invalidCursor();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = Number(view.getBigUint64(0));
  const issuedAt = Number(view.getBigUint64(TIMESTAMP_BYTES));
  const expiresAt = Number(view.getBigUint64(2 * TIMESTAMP_BYTES));
  if (
    !validTimestamp(at) ||
    !validTimestamp(issuedAt) ||
    !validTimestamp(expiresAt) ||
    issuedAt > now ||
    expiresAt !== issuedAt + CURSOR_TTL_MS ||
    expiresAt <= now
  )
    throw invalidCursor();
  let id = '';
  for (let offset = HEADER_BYTES; offset < bytes.length; offset += 2) {
    id += String.fromCharCode(view.getUint16(offset));
  }
  return { at, id };
}

function decodeEnvelope(token: string): Envelope {
  if (typeof token !== 'string' || token.length > MAX_CURSOR_LENGTH) throw invalidCursor();
  const match =
    /^sc1\.(0|[1-9]\d*)\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{80})\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!match?.[1] || match[0] !== token || !match[2] || !match[3] || !match[4]) {
    throw invalidCursor();
  }
  const kekVersion = Number(match[1]);
  if (!Number.isSafeInteger(kekVersion)) throw invalidCursor();
  try {
    const iv = fromBase64Url(match[2]);
    const wrappedDek = fromBase64Url(match[3]);
    const ciphertext = fromBase64Url(match[4]);
    if (
      iv.length !== IV_BYTES ||
      wrappedDek.length !== WRAPPED_DEK_BYTES ||
      ciphertext.length < TAG_BYTES + HEADER_BYTES + 2 ||
      ciphertext.length > TAG_BYTES + HEADER_BYTES + MAX_ID_LENGTH * 2 ||
      toBase64Url(iv) !== match[2] ||
      toBase64Url(wrappedDek) !== match[3] ||
      toBase64Url(ciphertext) !== match[4]
    )
      throw invalidCursor();
    return { kekVersion, iv, wrappedDek, ciphertext };
  } catch {
    throw invalidCursor();
  }
}

/** Encrypt a position under the current KEK, binding it to the complete effective request scope. */
export async function encodeConsoleCursor(
  ctx: CursorContext,
  scope: ConsoleCursorScope,
  position: ScanCursorPosition,
): Promise<string> {
  const data = payload(position, ctx.clock.now());
  const ring = await loadKekRing(ctx.env);
  if (!Number.isSafeInteger(ring.current) || ring.current < 0) {
    throw new Error('Invalid scan cursor key version.');
  }
  const envelope = await encryptSecret(ring, data, associatedData(scope, ring.current));
  const token = [
    'sc1',
    String(envelope.kekVersion),
    toBase64Url(envelope.iv),
    toBase64Url(envelope.wrappedDek),
    toBase64Url(envelope.ciphertext),
  ].join('.');
  if (token.length > MAX_CURSOR_LENGTH) throw new Error('Scan cursor exceeds the maximum length.');
  return token;
}

/** Reject every malformed, expired, cross-scope or unauthenticated token with the same error. */
export async function decodeConsoleCursor(
  ctx: CursorContext,
  scope: ConsoleCursorScope,
  token: string,
): Promise<ScanCursorPosition> {
  const envelope = decodeEnvelope(token);
  // Configuration failures remain server errors; a missing historical key is an invalid token.
  const ring = await loadKekRing(ctx.env);
  let bytes: Uint8Array;
  try {
    bytes = await decryptSecret(ring, envelope, associatedData(scope, envelope.kekVersion));
  } catch {
    throw invalidCursor();
  }
  const now = ctx.clock.now();
  if (!validTimestamp(now)) throw new Error('Invalid scan cursor clock.');
  return positionFromPayload(bytes, now);
}
