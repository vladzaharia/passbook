import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ScanSession } from '../../shared/contracts/scan-session.ts';
import { formatTime } from '../lib/format.ts';
import { getMode } from '../lib/mode.ts';
import { Buddy } from '../ui/art/buddy.tsx';
import { Button } from '../ui/button.tsx';
import type { ScanApi } from './api/scan-api.ts';
import { ScanAppView } from './app.tsx';
import { needsSessionRefetch } from './boot/use-scan-session.ts';
import { localOutcome } from './machine/outcome.ts';
import type { ScanOutcome } from './machine/types.ts';
import { useScanMachine } from './machine/use-scan-machine.ts';
import type { ScanRuntime } from './platform/runtime.ts';
import type { PassInspection } from './result/pass-inspector.tsx';
import { ResultCard } from './result/result-card.tsx';
import { BootCard } from './ui/boot-card.tsx';
import { CameraLayer } from './ui/camera-layer.tsx';
import { CountChip, ReaderChip, SyncChip, TestChip } from './ui/chips.tsx';
import { DoorDock } from './ui/door-dock.tsx';
import type { Announcement } from './ui/live-announcer.tsx';
import { type CameraChoice, ScanMenu } from './ui/scan-menu.tsx';
import { ScanOverlays, type ScanPanel } from './ui/scan-overlays.tsx';
import './buddy/beats.css';

const OperatorPanel = lazy(() =>
  import('./operator/operator-panel.tsx').then((m) => ({ default: m.OperatorPanel })),
);

export function ScanLoop({
  runtime,
  session,
  api,
  videoRef,
  announcement,
  refetch,
  leave,
}: {
  runtime: ScanRuntime;
  session: ScanSession;
  api: ScanApi;
  videoRef: { current: HTMLVideoElement | null };
  announcement: Announcement | null;
  refetch: () => Promise<void>;
  leave: () => void;
}) {
  const { state: s, view, dispatch, now } = useScanMachine();
  const [sheet, setSheet] = useState(false);
  const [panel, setPanel] = useState<ScanPanel>(null);
  const [pass, setPass] = useState<PassInspection | null>(null);
  const [cameraError, setCameraError] = useState('');
  const [shiftStart, setShiftStart] = useState(Date.now);
  const showPanel = (value: typeof panel) => {
    setPanel(value);
    dispatch({
      type: 'overlay',
      open: value === 'tips' ? 'settings' : value === 'end' ? 'shift' : value,
    });
  };
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !s.overlay) dispatch({ type: 'dismiss' });
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [s.overlay, dispatch]);
  const [cameraChoice, setCameraChoice] = useState<CameraChoice>('back');
  const requestedRev = useRef(0);
  useEffect(() => {
    if (s.overlay === null) {
      setSheet(false);
      setPanel(null);
      setPass(null);
    }
  }, [s.overlay]);
  const l = s.loop;
  const scanner = session.scanner;
  const counts = s.counts ?? session.counts;
  const last = s.recent[0];
  const result: ScanOutcome | null =
    l.s === 'verdict'
      ? l.outcome
      : l.s === 'member'
        ? {
            ...localOutcome('system', 'server', counts),
            kind: 'ready',
            reason: 'choose',
            card: l.card,
            display: l.card.display,
            local: false,
          }
        : null;
  useEffect(() => {
    if (needsSessionRefetch(session, s) && requestedRev.current !== counts.configRev) {
      requestedRev.current = counts.configRev;
      void refetch();
    }
  }, [session, s, counts.configRev, refetch]);
  const open = (next: boolean) => {
    if (next && operator) {
      document.querySelector<HTMLInputElement>('[data-operator-search]')?.focus();
      return;
    }
    dispatch({ type: 'overlay', open: next ? 'lookup' : null });
    setSheet(next);
  };
  const lastUndo = last?.scanId && last.undoable && (last.outcome.undoUntil ?? 0) > now;
  const operator = session.workspace?.device.effectiveSurface === 'operator';
  const menu = (
    <ScanMenu
      sound={s.prefs.sound}
      onSound={(value) => dispatch({ type: 'prefs', prefs: { sound: value } })}
      holdResults={s.prefs.holdResults}
      onHoldResults={(value) => dispatch({ type: 'prefs', prefs: { holdResults: value } })}
      camera={cameraChoice}
      cameraAvailable={!operator}
      hasWide={runtime.camera.hasWide()}
      onCamera={(choice) => {
        setCameraChoice(choice);
        runtime.camera.choose(choice);
      }}
      hasReader={s.reader.kind !== 'none'}
      cameraOff={s.camera === 'disabled'}
      onCameraOff={(off) => {
        if (off) runtime.camera.stop();
        dispatch({ type: 'camera', status: off ? 'disabled' : 'off' });
        if (!off && s.started) runtime.camera.start();
      }}
      onReaderTips={() => showPanel('tips')}
      onShift={() => showPanel('shift')}
      onEndShift={() => showPanel('end')}
      leave={session.principal === 'admin' ? 'stop-admin' : 'unpair'}
      onLeave={leave}
    />
  );
  return (
    <>
      <ScanAppView
        surface={operator ? 'operator' : 'phone'}
        sidebar={
          operator ? (
            <Suspense fallback={null}>
              <OperatorPanel api={api} runtime={runtime} session={session} />
            </Suspense>
          ) : null
        }
        screen={
          !s.started
            ? {
                s: 'start',
                scannerName: scanner?.name ?? 'Scan as admin',
                orgName: scanner?.orgName ?? session.admin?.orgs[0]?.name ?? '',
                mode: scanner?.mode ?? getMode(),
                state:
                  session.state === 'not_open' || session.state === 'closed'
                    ? session.state
                    : 'ready',
                templates: session.templates.map((t) => t.name),
                event: session.event
                  ? {
                      name: session.event.name,
                      when: `${formatTime(session.event.opensAt)}–${formatTime(session.event.closesAt)}`,
                      note: session.event.note,
                    }
                  : null,
              }
            : { s: 'loop' }
        }
        capsule={{
          name: scanner?.name ?? 'Scan as admin',
          staff: session.staff?.name,
          state: !s.online
            ? 'offline'
            : l.s === 'checking' || l.s === 'applying'
              ? 'checking'
              : l.s === 'paused'
                ? 'paused'
                : 'scanning',
          menu,
          onTitle: () => showPanel('shift'),
          chips: (
            <>
              <TestChip mode={scanner?.mode ?? getMode()} />
              {s.reader.kind !== 'none' ? (
                <ReaderChip state={s.focused ? 'ready' : 'paused'} />
              ) : null}
              {!s.online ? <SyncChip state={{ kind: 'offline', queued: 0 }} /> : null}
              <CountChip
                count={counts.event?.arrived ?? counts.today}
                capacity={counts.event?.expected}
                today={!counts.event}
              />
            </>
          ),
        }}
        camera={
          operator ? null : (
            <CameraLayer
              videoRef={videoRef}
              status={s.camera}
              checking={l.s === 'checking' || l.s === 'applying'}
              result={Boolean(result) || l.s === 'paused' || Boolean(s.block)}
              onRetry={runtime.camera.start}
              reader={s.reader.kind !== 'none'}
            />
          )
        }
        card={
          s.block ? (
            <BootCard
              title="Scanner unavailable"
              line="Pair this device again."
              testId="scan-block"
            >
              <Button onClick={leave}>Pair again</Button>
            </BootCard>
          ) : result && s.card ? (
            <ResultCard
              key={s.card.id}
              outcome={result}
              onPass={(card) => {
                if (card) setPass({ card });
                else if ('input' in l) setPass({ input: l.input });
                dispatch({ type: 'overlay', open: 'settings' });
              }}
              phase={s.card.phase}
              eventNote={session.event?.note}
              holdMs={l.s === 'verdict' && l.closeAt ? Math.max(0, l.closeAt - l.since) : null}
              onAction={(actionId) => dispatch({ type: 'pick', actionId })}
            />
          ) : l.s === 'paused' ? (
            <BootCard title="Paused">
              <Button onClick={runtime.resume}>Resume</Button>
            </BootCard>
          ) : null
        }
        tint={view.tint}
        buddy={
          <Buddy
            key={view.buddy.key}
            scene="scan"
            size="xl-scan"
            mood={view.buddy.mood === 'neutral' ? 'flat' : view.buddy.mood}
            pose={view.buddy.pose}
            beat={view.buddy.beat ?? undefined}
            card={view.buddy.card}
            immediate
          />
        }
        dockRow={
          <DoorDock outcome={result} runtime={runtime} open={open} onError={setCameraError} />
        }
        strip={
          last
            ? {
                kind:
                  last.outcome.kind === 'ok'
                    ? 'ok'
                    : last.outcome.kind === 'heads_up'
                      ? 'heads_up'
                      : last.outcome.kind === 'refused'
                        ? 'refused'
                        : 'system',
                title:
                  last.outcome.display?.identity.holder ?? last.outcome.action?.label ?? 'Scan',
                meta: formatTime(last.at),
                undoable: Boolean(lastUndo),
              }
            : null
        }
        announcement={announcement}
        on={{
          start: () => {
            setShiftStart(Date.now());
            runtime.start();
          },
          openRecent: () => showPanel('recent'),
          undo: () => {
            if (last?.scanId) dispatch({ type: 'undo', scanId: last.scanId });
          },
        }}
      />
      <ScanOverlays
        allowPeople={scanner?.settings.lookup ?? true}
        orgId={session.principal === 'admin' ? session.admin?.orgs[0]?.id : undefined}
        timeZone={session.event?.timeZone}
        sheet={sheet}
        panel={panel}
        pass={pass}
        api={api}
        runtime={runtime}
        open={open}
        showPanel={showPanel}
        closePass={() => {
          setPass(null);
          dispatch({ type: 'overlay', open: null });
        }}
        shiftStart={shiftStart}
        cameraError={cameraError}
        clearError={() => setCameraError('')}
      />
    </>
  );
}
