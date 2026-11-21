import { errorMessage, isApiError } from '../../../lib/errors.ts';
import { CHANGE_COPY as C } from './copy.ts';

/** One terse sentence for a refused change call: what happened and what to do. */
export function refusalText(error: unknown): string {
  if (isApiError(error)) {
    const known = C.refusal[error.code];
    if (known) return known;
    // The plan cap and the sandbox quota arrive worded for people.
    if (error.code === 'FEATURE_LIMIT_REACHED' || error.code === 'SANDBOX_QUOTA')
      return error.message;
  }
  return errorMessage(error);
}

export const isDrift = (error: unknown): boolean =>
  isApiError(error) && error.code === 'SELECTION_CHANGED';
