import { useEffect, useRef, useState } from 'react';
import type { ScanSession } from '../../shared/contracts/scan-session.ts';
import { formatTime } from '../lib/format.ts';
import { getMode } from '../lib/mode.ts';
import { Buddy } from '../ui/art/buddy.tsx';
import { Button } from '../ui/button.tsx';
import { Dialog, DialogContent } from '../ui/dialog.tsx';
import type { ScanApi } from './api/scan-api.ts';
import { ScanAppView } from './app.tsx';
import { needsSessionRefetch } from './boot/use-scan-session.ts';
import { LookupSheet } from './lookup/lookup-sheet.tsx';
import { localOutcome } from './machine/outcome.ts';
import type { ScanOutcome } from './machine/types.ts';
import { useScanMachine } from './machine/use-scan-machine.ts';
import type { ScanRuntime } from './platform/runtime.ts';
import { ResultCard } from './result/result-card.tsx';
import { BootCard } from './ui/boot-card.tsx';
import { CountChip, ReaderChip, SyncChip, TestChip } from './ui/chips.tsx';
import { DockButton, DoorThumbRow } from './ui/dock.tsx';
import type { Announcement } from './ui/live-announcer.tsx';
import { type CameraChoice, ScanMenu } from './ui/scan-menu.tsx';
import './buddy/beats.css';

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
  const [sheet, setSheet] = useState<'lookup' | 'code' | null>(null);
  const [recent, setRecent] = useState(false);
  const [cameraChoice, setCameraChoice] = useState<CameraChoice>('back');
  const requestedRev = useRef(0);
  useEffect(() => {
    if (s.overlay === null) setSheet(null);
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
            local: false,
          }
        : null;
  useEffect(() => {
    if (needsSessionRefetch(session, s) && requestedRev.current !== counts.configRev) {
      requestedRev.current = counts.configRev;
      void refetch();
    }
  }, [session, s, counts.configRev, refetch]);
  const open = (next: 'lookup' | 'code' | null) => {
    dispatch({ type: 'overlay', open: next ? 'lookup' : null });
    setSheet(next);
  };
  const lastUndo = last?.scanId && last.undoable && (last.outcome.undoUntil ?? 0) > now;
  const menu = (
    <ScanMenu
      sound={s.prefs.sound}
      onSound={(value) => dispatch({ type: 'prefs', prefs: { sound: value } })}
      holdResults={s.prefs.holdResults}
      onHoldResults={(value) => dispatch({ type: 'prefs', prefs: { holdResults: value } })}
      camera={cameraChoice}
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
      onShift={() => setRecent(true)}
      onEndShift={() => location.reload()}
      leave={session.principal === 'admin' ? 'stop-admin' : 'unpair'}
      onLeave={leave}
    />
  );
  return (
    <>
      <ScanAppView
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
          <>
            <video ref={videoRef} muted playsInline className="scan-video" aria-hidden />
            {s.camera !== 'live' ? (
              <p className="scan-stage-message">
                {s.camera === 'starting'
                  ? 'Opening camera…'
                  : s.camera === 'blocked'
                    ? 'Camera blocked. Allow camera access or type a code.'
                    : s.camera === 'decoder_failed'
                      ? 'Camera reader unavailable. Type a code.'
                      : 'Scan a barcode or type a code'}
              </p>
            ) : null}
          </>
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
              outcome={result}
              phase={s.card.phase}
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
          result ? (
            <>
              {result.overridable && result.action ? (
                <DockButton
                  variant="filled"
                  onClick={() => dispatch({ type: 'override', actionId: result.action?.id ?? '' })}
                >
                  Let in again
                </DockButton>
              ) : null}
              {result.reason === 'check_required' && result.action ? (
                <DockButton
                  variant="filled"
                  onClick={() => dispatch({ type: 'override', actionId: result.action?.id ?? '' })}
                >
                  Check in
                </DockButton>
              ) : null}
              <DockButton primary onClick={() => dispatch({ type: 'dismiss' })}>
                Done
              </DockButton>
            </>
          ) : (
            <DoorThumbRow
              canTorch={false}
              onLookUp={() => open('lookup')}
              onKeyboard={() => open('code')}
            />
          )
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
          start: runtime.start,
          openRecent: () => setRecent(true),
          undo: () => {
            if (last?.scanId) dispatch({ type: 'undo', scanId: last.scanId });
          },
        }}
      />
      <LookupSheet
        open={sheet}
        api={api}
        onClose={() => open(null)}
        onRead={(read) => {
          open(null);
          runtime.emit({ method: 'manual', ...read });
        }}
      />
      <Dialog open={recent} onOpenChange={setRecent}>
        <DialogContent title="Recent" size="sm">
          {s.recent.length ? (
            s.recent.map((row) => (
              <div
                key={row.scanId ?? row.at}
                className="flex items-center justify-between gap-3 py-2"
              >
                <p>
                  {row.outcome.display?.identity.holder ??
                    row.outcome.action?.label ??
                    row.outcome.reason}{' '}
                  · {formatTime(row.at)}
                </p>
                {row.undoable && row.scanId && (row.outcome.undoUntil ?? 0) > now ? (
                  <Button
                    variant="secondary"
                    disabled={s.undo !== null}
                    onClick={() => dispatch({ type: 'undo', scanId: row.scanId ?? '' })}
                  >
                    Undo
                  </Button>
                ) : null}
              </div>
            ))
          ) : (
            <p>No scans yet.</p>
          )}
          {s.unsure.length ? (
            <p>{s.unsure.length} scans not confirmed yet. Keep this page open.</p>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
