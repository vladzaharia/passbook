import { useCallback, useEffect, useRef, useState } from 'react';
import {
  connectDeviceSocket,
  type DeviceSocketDeps,
  deviceSocketUrl,
} from '../../enroll/device-socket.ts';

/**
 * The operator's one hub connection. A pulse means a scan was recorded in this session: the lists
 * read again. Roll call rides the same socket through `connect`, so the device never holds a
 * third one (the hub keeps two per device). `up` is false while the hub is away: the polls carry on alone.
 */
export function useHub(enabled: boolean) {
  const [up, setUp] = useState(false);
  const [pulses, setPulses] = useState(0);
  const listeners = useRef(new Set<DeviceSocketDeps>());
  const open = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    const socket = connectDeviceSocket({
      url: deviceSocketUrl(location),
      onOpen: () => {
        open.current = true;
        setUp(true);
        for (const l of listeners.current) l.onOpen();
      },
      onClose: () => {
        open.current = false;
        setUp(false);
      },
      onNudge: (nudge) => {
        if (nudge.kind === 'activity') setPulses((n) => n + 1);
        for (const l of listeners.current) l.onNudge(nudge);
      },
    });
    return () => {
      socket.close();
      open.current = false;
      setUp(false);
    };
  }, [enabled]);
  /** Stands in for `connectDeviceSocket` in a hook that wants nudges: it shares this socket. */
  const connect = useCallback((deps: DeviceSocketDeps) => {
    listeners.current.add(deps);
    if (open.current) deps.onOpen();
    return { close: () => void listeners.current.delete(deps) };
  }, []);
  return { up, pulses, connect };
}
export type Hub = ReturnType<typeof useHub>;
