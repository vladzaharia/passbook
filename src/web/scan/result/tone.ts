import type { ScanOutcome } from '../machine/types.ts';

export type Tone = 'ok' | 'heads_up' | 'refused' | 'system';

/** The colour family of an outcome kind. A read saved offline is a check-in the door has taken. */
export const toneOf = (kind: ScanOutcome['kind']): Tone =>
  kind === 'ok' || kind === 'queued'
    ? 'ok'
    : kind === 'heads_up' || kind === 'refused'
      ? kind
      : 'system';
