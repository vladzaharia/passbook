import { useSyncExternalStore } from 'react';

/** Window event: the failure count moved, so the device report can carry it. */
export const DRAFT_HEALTH_EVENT = 'passbook:scan-draft-health';

/**
 * How the draft calls are doing, for the desk and for scanner health. Staff are never told of a
 * failure; the "On screen" chip shows only while the last draft reached a screen.
 */
let failures = 0;
let onScreen = false;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export const draftHealth = {
  failed() {
    failures += 1;
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(DRAFT_HEALTH_EVENT));
  },
  setOnScreen(on: boolean) {
    if (on === onScreen) return;
    onScreen = on;
    emit();
  },
  failures: () => failures,
  onScreen: () => onScreen,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  reset() {
    failures = 0;
    onScreen = false;
    emit();
  },
};

export type DraftHealth = Pick<typeof draftHealth, 'failed' | 'setOnScreen'>;

export const useDraftOnScreen = () =>
  useSyncExternalStore(draftHealth.subscribe, draftHealth.onScreen, () => false);
