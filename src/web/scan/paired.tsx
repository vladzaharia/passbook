import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ScanSession } from '../../shared/contracts/scan-session.ts';
import { errorMessage } from '../lib/errors.ts';
import type { ScanApi } from './api/scan-api.ts';
import { WedgeFieldsContext } from './input/wedge-field.tsx';
import type { ScanState } from './machine/types.ts';
import { ScanStoreContext } from './machine/use-scan-machine.ts';
import { createRuntime, type ScanRuntime } from './platform/runtime.ts';

const ScanLoop = lazy(() => import('./scan-loop.tsx').then((m) => ({ default: m.ScanLoop })));

import { BootCard } from './ui/boot-card.tsx';
import type { Announcement } from './ui/live-announcer.tsx';
import { ScanShell } from './ui/scan-shell.tsx';

export function Paired({
  session,
  api,
  refetch,
  onMachine,
}: {
  session: ScanSession;
  api: ScanApi;
  refetch: () => Promise<void>;
  onMachine: (state: ScanState | null) => void;
}) {
  const [runtime, setRuntime] = useState<ScanRuntime | null>(null);
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  useEffect(() => {
    let active = true;
    let instance: ScanRuntime | null = null;
    setRuntime(null);
    void createRuntime(sessionRef.current, api, () => videoRef.current, setAnnouncement)
      .then((next) => {
        if (!active) {
          next.dispose();
          return;
        }
        instance = next;
        setRuntime(next);
      })
      .catch((error) =>
        setAnnouncement({ text: errorMessage(error), polite: false, n: Date.now() }),
      );
    return () => {
      active = false;
      instance?.dispose();
    };
  }, [api]);
  useEffect(() => {
    if (!runtime) return;
    const update = () => onMachine(runtime.store.getSnapshot().state);
    update();
    return runtime.store.subscribe(update);
  }, [runtime, onMachine]);
  if (!runtime) return <ScanShell cardMode="boot" card={<BootCard title="Loading scanner…" />} />;
  return (
    <ScanStoreContext.Provider value={runtime.store}>
      <WedgeFieldsContext.Provider value={runtime.fields}>
        <Suspense fallback={null}>
          <ScanLoop
            runtime={runtime}
            session={session}
            api={api}
            videoRef={videoRef}
            announcement={announcement}
            refetch={refetch}
            leave={() => {
              if (session.principal === 'admin') {
                location.assign('/admin/scanning');
                return;
              }
              void runtime
                .clear()
                .then(() => api.signOut())
                .then(
                  () => location.reload(),
                  (error) =>
                    setAnnouncement({ text: errorMessage(error), polite: false, n: Date.now() }),
                );
            }}
          />
        </Suspense>
      </WedgeFieldsContext.Provider>
    </ScanStoreContext.Provider>
  );
}
