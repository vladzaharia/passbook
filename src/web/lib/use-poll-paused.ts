import { useSyncExternalStore } from 'react';
import { pollPaused, subscribePoll } from './poll-backoff.ts';

/** True while a poller waits out a 429. */
export const usePollPaused = (): boolean => useSyncExternalStore(subscribePoll, pollPaused);
