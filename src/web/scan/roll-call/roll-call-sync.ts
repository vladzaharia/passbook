import type { RollCallMarksResponse } from '../../../shared/contracts/scan-roll-call.ts';
import { ApiError } from '../../lib/errors.ts';
import type { QueuedMark } from './roll-call-model.ts';

/** A call the server closed under us, or one that is gone: drop the queue and start clean. */
export const gone = (error: unknown) =>
  error instanceof ApiError && (error.code === 'ROLL_CALL_ENDED' || error.status === 404);

/** Identical answers to one failing batch before it is isolated per mark. */
export const STUCK = 5;

/** A 4xx or 5xx the server gives for the taps themselves; a sign-in refusal or a missing call is another matter. */
export const failsTaps = (status: number) =>
  status >= 400 && status < 600 && status !== 401 && status !== 403 && status !== 404;

/**
 * Counts identical answers to the batch that keeps failing; true once there have been STUCK in a row.
 * The key names the batch by its first mark only, so taps added behind it do not reset the count.
 */
export function stuck(
  repeats: { current: { key: string; n: number } },
  status: number,
  error: unknown,
  batch: readonly QueuedMark[],
): boolean {
  const first = batch[0];
  const key = `${status}:${error instanceof ApiError ? error.code : ''}:${first?.passId}:${first?.status}:${first?.at}`;
  repeats.current = { key, n: repeats.current.key === key ? repeats.current.n + 1 : 1 };
  return repeats.current.n >= STUCK;
}

export interface Isolated {
  /** Saved one by one: the server took them. */
  done: QueuedMark[];
  /** The server answered 4xx to the tap alone. */
  bad: { mark: QueuedMark; code: string }[];
  /** The server answered 5xx to the tap alone. */
  failed: { mark: QueuedMark; code: string }[];
  /** An error that is not about one tap (network, sign-in, call gone): sending stopped there. */
  halt: unknown;
  last: RollCallMarksResponse | null;
}

/** Sends a failing batch one mark at a time, so the bad tap is found and the good ones are saved. */
export async function isolate(
  send: (marks: QueuedMark[]) => Promise<RollCallMarksResponse>,
  batch: readonly QueuedMark[],
): Promise<Isolated> {
  const out: Isolated = { done: [], bad: [], failed: [], halt: null, last: null };
  for (const mark of batch) {
    try {
      out.last = await send([mark]);
      out.done.push(mark);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      const code = error instanceof ApiError ? error.code : '';
      if (gone(error) || !failsTaps(status)) {
        out.halt = error;
        break;
      }
      (status < 500 ? out.bad : out.failed).push({ mark, code });
    }
  }
  return out;
}
