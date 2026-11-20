import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ScanSession } from '../../shared/contracts/scan-session.ts';
import { PHONE, useMediaQuery } from '../lib/media.ts';
import { getMode } from '../lib/mode.ts';
import { Buddy } from '../ui/art/buddy.tsx';
import { Button } from '../ui/button.tsx';
import type { ScanApi } from './api/scan-api.ts';
import { ScanAppView } from './app.tsx';
import { useTagUi } from './assign/use-tag-ui.tsx';
import { needsSessionRefetch } from './boot/use-scan-session.ts';
import { LoopMenu } from './loop-menu.tsx';
import { loopScreen } from './loop-screen.ts';
import type { ScanOutcome } from './machine/types.ts';
import { useScanMachine } from './machine/use-scan-machine.ts';
import type { ScanRuntime } from './platform/runtime.ts';
import { scanBrandLogoUrl } from './platform/scan-branding.tsx';
import { useNativeCapabilities } from './platform/use-native-capabilities.ts';
import { useVerdictHaptic } from './platform/use-verdict-haptic.ts';
import { canAddPhoto } from './result/add-photo.tsx';
import { deskOf, resultOf } from './result/desk.ts';
import type { PassInspection } from './result/pass-inspector.tsx';
import { ResultCard } from './result/result-card.tsx';
import { BootCard } from './ui/boot-card.tsx';
import { CameraLayer } from './ui/camera-layer.tsx';
import { ReaderChip, SyncChip, syncChipOf, TestChip } from './ui/chips.tsx';
import { DoorDock } from './ui/door-dock.tsx';
import type { Announcement } from './ui/live-announcer.tsx';
import { modeLabel } from './ui/mode-label.ts';
import type { CameraChoice } from './ui/scan-menu.tsx';
import { ScanOverlays, type ScanPanel } from './ui/scan-overlays.tsx';
import { setSessionZone } from './ui/session-time.ts';
import { dockStrip } from './ui/strip-of.ts';
import { useAccessUi } from './ui/use-access-ui.tsx';
import './buddy/beats.css';

const OperatorPanel = lazy(() =>
  import('./operator/operator-panel.tsx').then((m) => ({ default: m.OperatorPanel })),
);
const OperatorWorkspace = lazy(() =>
  import('./operator/workspace/workspace.tsx').then((m) => ({ default: m.OperatorWorkspace })),
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
  const phone = useMediaQuery(PHONE);
  setSessionZone(session.scanner?.timeZone ?? session.event?.timeZone);
  const [sheet, setSheet] = useState(false);
  const [panel, setPanel] = useState<ScanPanel>(null);
  const [pass, setPass] = useState<PassInspection | null>(null);
  const [cameraError, setCameraError] = useState('');
  const [shiftStart, setShiftStart] = useState(Date.now);
  const sync = syncChipOf(s, now);
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
  const branding = session.branding ?? null;
  const logoUrl = scanBrandLogoUrl(branding, session);
  const counts = s.counts ?? session.counts;
  const nativeCapabilities = useNativeCapabilities();
  const duoLayout =
    nativeCapabilities?.layout?.posture === 'unfolded' ||
    nativeCapabilities?.layout?.posture === 'half-folded';
  const operator = session.workspace?.device.effectiveSurface === 'operator';
  const operatorPane = operator || duoLayout;
  // Phones keep the handheld layout and its operator panel.
  const workspace = operator && !duoLayout && s.started && !phone;
  const nativeBarcode =
    session.workspace?.device.capabilities?.nativeBarcode ??
    nativeCapabilities?.platform === 'android';
  const readerUsable =
    (s.reader.kind === 'barcode' && nativeBarcode) ||
    (s.reader.kind === 'nfc' && nativeCapabilities?.vas.available === true);
  const last = s.recent[0];
  const result: ScanOutcome | null = resultOf(l, counts);
  useVerdictHaptic(l.s === 'verdict' ? l.outcome : null);
  useEffect(() => {
    if (needsSessionRefetch(session, s) && requestedRev.current !== counts.configRev) {
      requestedRev.current = counts.configRev;
      void refetch();
    }
  }, [session, s, counts.configRev, refetch]);
  const open = (next: boolean) => {
    if (next && operatorPane) {
      document.querySelector<HTMLInputElement>('[data-operator-search]')?.focus();
      return;
    }
    dispatch({ type: 'overlay', open: next ? 'lookup' : null });
    setSheet(next);
  };
  const access = useAccessUi({
    runtime,
    session,
    api,
    counts,
    online: s.online,
    overlay: s.overlay,
    dispatch,
  });
  const tags = useTagUi({ runtime, session, api, state: s, result, open, dispatch });
  const lastUndo = last?.scanId && last.undoable && (last.outcome.undoUntil ?? 0) > now;
  const menu = (
    <LoopMenu
      {...{ s, session, api, runtime, tags, dispatch, refetch, leave, operator, duoLayout }}
      {...{ readerUsable, cameraChoice, setCameraChoice, setCameraError, showPanel }}
    />
  );
  const cardNode = s.block ? (
    <BootCard title="Scanner unavailable" line="Pair this device again." testId="scan-block">
      <Button onClick={leave}>Pair again</Button>
    </BootCard>
  ) : tags.card ? (
    tags.card
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
      clock={now}
      eventNote={session.event?.note}
      holdMs={l.s === 'verdict' && l.closeAt ? Math.max(0, l.closeAt - l.since) : null}
      onAction={(actionId) => dispatch({ type: 'pick', actionId })}
      onGroup={() => dispatch({ type: 'group' })}
      desk={deskOf(l, session, dispatch)}
      addPhoto={canAddPhoto(session) ? api : undefined}
      tagRead={'input' in l && Boolean(l.input.tag)}
    />
  ) : l.s === 'paused' ? (
    <BootCard title="Paused">
      <Button onClick={runtime.resume}>Resume</Button>
    </BootCard>
  ) : null;
  const testChip = <TestChip mode={scanner?.mode ?? getMode()} />;
  const chipsNode = (
    <>
      {readerUsable ? <ReaderChip state={s.focused ? 'ready' : 'paused'} /> : null}
      {sync ? <SyncChip state={sync} /> : null}
      {access.chips}
      {tags.chip}
    </>
  );
  const appView = (
    <ScanAppView
      branding={branding}
      surface={duoLayout ? 'duo' : operator ? 'operator' : 'phone'}
      layout={nativeCapabilities?.layout}
      sidebar={
        operatorPane ? (
          <Suspense fallback={null}>
            <OperatorPanel api={api} runtime={runtime} session={session} />
          </Suspense>
        ) : null
      }
      screen={loopScreen(session, s.started)}
      capsule={{
        logoUrl,
        orgName: scanner?.orgName ?? session.admin?.orgs[0]?.name ?? '',
        name: scanner?.name ?? 'Scan as admin',
        staff: session.staff?.name,
        mode: modeLabel(session),
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
            {testChip}
            {chipsNode}
          </>
        ),
      }}
      camera={
        operator && !duoLayout ? null : (
          <CameraLayer
            videoRef={videoRef}
            status={s.camera}
            checking={l.s === 'checking' || l.s === 'applying'}
            result={Boolean(result) || l.s === 'paused' || Boolean(s.block) || tags.dim}
            onRetry={runtime.camera.start}
            reader={readerUsable}
          />
        )
      }
      card={cardNode}
      tint={tags.tint ?? view.tint}
      buddy={
        <Buddy
          key={view.buddy.key}
          scene="scan"
          size="xl-scan"
          mood={view.buddy.mood === 'neutral' ? 'flat' : view.buddy.mood}
          pose={tags.pose ?? view.buddy.pose}
          beat={view.buddy.beat ?? undefined}
          card={view.buddy.card}
          immediate
        />
      }
      dockRow={
        tags.dock ?? (
          <DoorDock
            outcome={result}
            runtime={runtime}
            open={open}
            onError={setCameraError}
            inside={access.inside}
            visitors={access.visitors}
            tags={tags}
          />
        )
      }
      strip={tags.strip ?? dockStrip(s, last, Boolean(lastUndo), now)}
      announcement={announcement}
      on={{
        start: () => {
          setShiftStart(Date.now());
          runtime.start();
        },
        openRecent: () => showPanel('recent'),
        undo: () => {
          if (tags.strip && tags.onUndo) tags.onUndo();
          else if (last?.scanId) dispatch({ type: 'undo', scanId: last.scanId });
        },
      }}
    />
  );
  return (
    <>
      {workspace ? (
        <Suspense fallback={null}>
          <OperatorWorkspace
            {...{ api, runtime, session, branding, logoUrl, menu, counts, announcement }}
            modeLabel={modeLabel(session)}
            chips={chipsNode}
            testing={testChip}
            scanCard={cardNode}
            dock={tags.dock}
            onTitle={() => showPanel('shift')}
          />
        </Suspense>
      ) : (
        appView
      )}
      {access.layer}
      {tags.layer}
      <ScanOverlays
        allowPeople={scanner?.settings.lookup ?? true}
        sessionTotals={session.staff?.role === 'manager' && Boolean(session.workspace)}
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
