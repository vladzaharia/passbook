import type { PassImportDto, PassImportState } from '@/shared/contracts/pass-imports.ts';

import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export const STATE_LABEL: Record<PassImportState, string> = {
  mapping: 'Check mapping',
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

/** The badge: a draft with rows to fix is not ready, whatever the server's state. */
export function stateBadge(imp: Pick<PassImportDto, 'state' | 'counts'>): {
  label: string;
  tone: Tone;
} {
  if (imp.state === 'ready' && (imp.counts?.errors ?? 0) > 0)
    return { label: C.check.tileFix, tone: 'warning' };
  return { label: STATE_LABEL[imp.state], tone: STATE_TONE[imp.state] };
}
