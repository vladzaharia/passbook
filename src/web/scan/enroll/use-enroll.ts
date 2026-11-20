import { useEffect, useRef } from 'react';
import type { TagEnrollment } from '../assign/types.ts';
import type { MachineEvent } from '../machine/access-events.ts';
import { connectDeviceSocket, type DeviceNudge, deviceSocketUrl } from './device-socket.ts';

export type ResolvedMessage = Extract<DeviceNudge, { kind: 'resolved' }>['resolved'];

export interface EnrollSource {
  pending(o: { signal: AbortSignal }): Promise<TagEnrollment | null>;
}

/**
 * An admin's tag requests reach this scanner over the device socket and `pending`. `enabled` is
 * the scanner reading tags with a role that can enroll; `showing` is the id of the request on
 * screen, so a reconnect that finds none ends it.
 */
export function useEnrollment({
  api,
  enabled,
  showing,
  dispatch,
  onResolved,
}: {
  api: EnrollSource;
  enabled: boolean;
  showing: string | null;
  dispatch: (event: MachineEvent) => void;
  onResolved: (resolved: ResolvedMessage) => void;
}): void {
  const resolved = useRef(onResolved);
  resolved.current = onResolved;
  const current = useRef(showing);
  current.current = showing;
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let ac: AbortController | null = null;
    const read = () => {
      ac?.abort();
      const own = new AbortController();
      ac = own;
      api.pending({ signal: own.signal }).then(
        (request) => {
          if (!alive || own.signal.aborted) return;
          if (request) dispatch({ type: 'enroll.arrive', request });
          else if (current.current) dispatch({ type: 'enroll.cancelled', id: current.current });
        },
        () => {
          // The next open or nudge reads it again; a failed read is not a verdict.
        },
      );
    };
    const socket = connectDeviceSocket({
      url: deviceSocketUrl(location),
      onOpen: read,
      onNudge: (nudge) => {
        if (nudge.kind === 'cancelled') dispatch({ type: 'enroll.cancelled', id: nudge.id });
        else if (nudge.kind === 'resolved') resolved.current(nudge.resolved);
        else if (nudge.kind === 'rollCall' || nudge.kind === 'activity') return;
        else read();
      },
    });
    const onVisible = () => {
      if (!document.hidden) read();
    };
    window.addEventListener('online', read);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      ac?.abort();
      socket.close();
      window.removeEventListener('online', read);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [api, enabled, dispatch]);
}
