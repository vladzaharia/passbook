import { useCallback, useEffect, useState } from 'react';
import type { z } from 'zod';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import type { SessionActivitySchema } from '../../../shared/contracts/scanning-sessions.ts';
import { formatTime } from '../../lib/format.ts';
import type { ScanApi } from '../api/scan-api.ts';
import { LookupPanel } from '../lookup/lookup-panel.tsx';
import { useScanMachine } from '../machine/use-scan-machine.ts';
import type { ScanRuntime } from '../platform/runtime.ts';
import './operator.css';

export function OperatorPanel({
  api,
  runtime,
  session,
}: {
  api: ScanApi;
  runtime: ScanRuntime;
  session: ScanSession;
}) {
  const { state, dispatch } = useScanMachine();
  const [activity, setActivity] = useState<z.infer<typeof SessionActivitySchema>['items']>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [generation, setGeneration] = useState(0);
  const editing = useCallback(
    (active: boolean) => {
      const current = runtime.store.getSnapshot().state;
      if (active && current.overlay === null) dispatch({ type: 'overlay', open: 'lookup' });
      else if (!active && current.overlay === 'lookup') dispatch({ type: 'overlay', open: null });
    },
    [runtime, dispatch],
  );
  useEffect(() => {
    if (state.loop.s === 'checking' || state.loop.s === 'applying') setGeneration((n) => n + 1);
  }, [state.loop.s]);
  const clear = () => {
    editing(false);
    setGeneration((n) => n + 1);
  };
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () =>
      void api.activity({ signal: controller.signal }).then(
        (data) => {
          setActivity(data.items);
          setUnavailable(false);
        },
        () => {
          if (!controller.signal.aborted) setUnavailable(true);
        },
      );
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [api]);
  return (
    <aside className="scan-operator" aria-label="Operator desk">
      <header>
        <p className="text-xs uppercase tracking-wider text-fg-muted">Operator</p>
        <h2 className="text-lg font-semibold">
          {session.workspace?.session.name ?? 'Check-in desk'}
        </h2>
      </header>
      <section aria-label="Find a pass">
        <LookupPanel
          key={generation}
          inline
          open
          api={api}
          allowPeople={session.scanner?.settings.lookup ?? false}
          orgId={session.scanner?.orgId}
          timeZone={session.scanner?.timeZone}
          onEditing={editing}
          onCode={(code) => {
            clear();
            runtime.emit({ method: 'manual', code });
          }}
          onCheckIn={(card, actionId) => {
            clear();
            runtime.checkIn(card, actionId);
          }}
        />
      </section>
      <section className="scan-operator-activity" aria-label="Session activity">
        <h2 className="text-sm font-semibold">Session activity</h2>
        {unavailable ? (
          <p role="status" className="text-sm text-fg-muted">
            Activity unavailable. Retrying…
          </p>
        ) : null}
        {!activity.length ? (
          <p className="text-sm text-fg-muted">Check-ins appear here.</p>
        ) : (
          <ol>
            {activity.map((row) => (
              <li key={row.id}>
                <span className="scan-activity-dot" data-outcome={row.outcome} />
                <div>
                  <p className="text-sm font-medium">
                    {row.title ?? (row.outcome === 'refused' ? 'Not accepted' : 'Pass')}
                  </p>
                  <p className="text-xs text-fg-muted">
                    {row.direction === 'out'
                      ? 'Out'
                      : row.outcome === 'undone'
                        ? 'Undone'
                        : row.outcome === 'ok'
                          ? 'In'
                          : 'Review'}{' '}
                    · {row.deviceName} · {formatTime(row.at, session.scanner?.timeZone)}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </aside>
  );
}
