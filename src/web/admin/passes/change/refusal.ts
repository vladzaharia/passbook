import { STATE_COPY, waitLine } from '@/shared/copy/states.ts';
import { type ApiError, errorMessage, isApiError } from '../../../lib/errors.ts';
import { CHANGE_COPY as C } from './copy.ts';

/** One terse sentence for a refused change call: what happened and what to do. */
export function refusalText(error: unknown): string {
  if (isRateLimited(error)) return `${STATE_COPY.rateLimited}. ${waitLine(error.retryAfter)}`;
  if (isApiError(error)) {
    // A change that cannot be undone says so itself: it names the rollback.
    if (error.code === 'BROADCAST_NOT_UNDOABLE') return error.message;
    const known = C.refusal[error.code];
    if (known) return known;
    // The plan cap and the sandbox quota arrive worded for people.
    if (error.code === 'FEATURE_LIMIT_REACHED' || error.code === 'SANDBOX_QUOTA')
      return error.message;
  }
  return errorMessage(error);
}

/** A 429: nothing was created, and the same call works again after the wait. */
export const isRateLimited = (error: unknown): error is ApiError =>
  isApiError(error) && error.status === 429;

export const isDrift = (error: unknown): boolean =>
  isApiError(error) && error.code === 'SELECTION_CHANGED';

/** Why a failed run stopped, from its error code; null when the code is not one a person can act on. */
export const runFailure = (code: string | null): string | null =>
  code ? (C.refusal[code] ?? null) : null;
