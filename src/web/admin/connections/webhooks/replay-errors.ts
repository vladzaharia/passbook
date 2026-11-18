import { errorMessage, isApiError } from '../../../lib/errors.ts';

/**
 * Words for a refused replay. A bulk replay that fails before its first chunk commits answers 409
 * with nothing queued (and the minute's allowance already spent); one that fails later answers 200
 * with the count that did queue, so a short count is the sign of a partial run.
 */
export function replayError(error: unknown, bulk: boolean): string {
  if (isApiError(error)) {
    if (error.code === 'DELIVERY_PENDING') return 'It is already waiting to be sent.';
    if (error.status === 409)
      return bulk
        ? 'Nothing was queued. Try again in a minute.'
        : 'It changed while you were replaying. Reload and try again.';
    if (error.status === 429)
      return bulk
        ? 'Replay is limited to one a minute. Try again shortly.'
        : 'Too many replays. Try again shortly.';
    if (error.code === 'REPLAY_TOO_LARGE')
      return `${error.message.replace(/\s*Narrow it\.?$/, '')} Choose a shorter range.`;
  }
  return errorMessage(error);
}

export const queuedLine = (n: number) => `Queued ${n} ${n === 1 ? 'delivery' : 'deliveries'}.`;
