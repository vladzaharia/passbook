/** Values the views derive from state (AC 3.6). Pure. */
import { SCAN_TIMING } from '../timing.ts';
import type { ScanState } from './types.ts';

/**
 * The decoder runs while the camera is live and nothing blocks it. B keeps the camera live during
 * results (SA 7.5): it pauses only while `checking`, the frozen frame from D0 to T0.
 */
export const decodeActive = (s: ScanState, visible: boolean): boolean =>
  visible &&
  s.started &&
  s.camera === 'live' &&
  s.block === null &&
  s.loop.s !== 'checking' &&
  s.loop.s !== 'applying' &&
  s.loop.s !== 'paused' &&
  (s.overlay === null || s.overlay === 'camera');

/** The pending badge: unsure plus queued, amber after 10 minutes. */
export const pendingBadge = (s: ScanState, now: number) => ({
  n: s.queue.pending + s.unsure.filter((u) => u.state === 'retrying').length,
  late: s.queue.oldestAt !== null && now - s.queue.oldestAt > 600_000,
});

export const readerChip = (s: ScanState): 'paused' | 'layout' | 'ready' | null =>
  s.reader.kind === 'none'
    ? null
    : !s.focused
      ? 'paused'
      : s.reader.badLayout >= 3
        ? 'layout'
        : 'ready';

/** A reader is set up but nothing has come from it for a while: show the tip. */
export const readerNoRead = (s: ScanState, now: number): boolean =>
  s.reader.kind !== 'none' &&
  s.loop.s === 'ready' &&
  now >= Math.max(s.lastActivity, s.reader.lastAt ?? 0) + SCAN_TIMING.READER_NO_READ_HINT;
