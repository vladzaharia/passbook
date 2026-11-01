import { onlineManager } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

/**
 * Network state as TanStack Query sees it (navigator.onLine plus online/offline events), so the
 * banner and paused mutations agree.
 */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (notify) => onlineManager.subscribe(notify),
    () => onlineManager.isOnline(),
    () => true,
  );
}

/** Button props for a mutation: busy while running, "Waiting for connection" while paused. */
export function mutationButton(m: { isPending: boolean; isPaused: boolean }) {
  return { loading: m.isPending && !m.isPaused, paused: m.isPaused };
}
