import { PassBuildError } from '../../../passkit/build.ts';
import { strictEmail } from '../../../shared/email.ts';
import { getPointer } from '../../connectors/lib/pointer.ts';
import type { RecordResult, UpstreamRecord } from '../../connectors/types.ts';
import { ValidationError } from '../../platform/errors.ts';
import type { ConnectionRow } from './repo.ts';

export type Incoming =
  | { kind: 'record'; record: UpstreamRecord; holderEmail?: string | undefined }
  | { kind: 'missing' }
  | { kind: 'unchanged' };

export function fromResult(result: RecordResult): Incoming {
  if (result.status === 'ok') {
    return { kind: 'record', record: result.record, holderEmail: result.holderEmail };
  }
  return result.status === 'not_found' ? { kind: 'missing' } : { kind: 'unchanged' };
}

function optionalHolderEmail(value: unknown): string | null {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return null;
  }
  const email = strictEmail(value);
  if (!email) {
    throw new ValidationError('The upstream holder email is invalid.', [], 'HOLDER_EMAIL_INVALID');
  }
  return email;
}

export function holderEmailOf(
  conn: ConnectionRow,
  incoming: { record: UpstreamRecord; holderEmail?: string | undefined },
) {
  const direct = optionalHolderEmail(incoming.holderEmail);
  if (direct) return direct;
  return conn.holderEmailField
    ? optionalHolderEmail(getPointer(incoming.record, conn.holderEmailField))
    : null;
}

export const MAX_SAMPLES = 5;
const SAMPLE_MAX = 300;

export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z_]{1,39}$/.test(code) ? code : 'RECORD_ERROR';
}

/** `ref: CODE path message; ...` for one failed record. */
export function describeFailure(ref: string, error: unknown): string {
  const issues: { path?: string | undefined; message: string }[] =
    error instanceof PassBuildError
      ? error.report.issues
      : error instanceof ValidationError
        ? (error.issues ?? [])
        : [];
  const detail = issues
    .slice(0, 3)
    .map((i) => `${i.path ? `${i.path} ` : ''}${i.message}`)
    .join('; ');
  return `${ref}: ${errorCode(error)}${detail ? ` ${detail}` : ''}`.slice(0, SAMPLE_MAX);
}
