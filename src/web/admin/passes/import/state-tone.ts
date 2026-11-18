import type { PassImportState } from '@/shared/contracts/pass-imports.ts';

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export const STATE_LABEL: Record<PassImportState, string> = {
  mapping: 'Needs columns',
  checking: 'Checking',
  ready: 'Ready',
  committing: 'Running',
  done: 'Done',
  failed: 'Failed',
  stale: 'Template changed',
  expired: 'Expired',
  discarded: 'Discarded',
};

export const STATE_TONE: Record<PassImportState, Tone> = {
  mapping: 'neutral',
  checking: 'info',
  ready: 'accent',
  committing: 'info',
  done: 'success',
  failed: 'danger',
  stale: 'warning',
  expired: 'neutral',
  discarded: 'neutral',
};
