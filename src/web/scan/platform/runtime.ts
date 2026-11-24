import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { offlineModeOf } from '../../../shared/scan-offline.ts';
import { getMode } from '../../lib/mode.ts';
import type { ScanApi } from '../api/scan-api.ts';
import { toFail } from '../api/to-fail.ts';
import { TAG_EXTRA_COPY } from '../assign/copy.ts';
import { tagsPortOf } from '../assign/tags-port.ts';
import { createCamera } from '../camera/controller.ts';
import { createBus } from '../input/bus.ts';
import { connectNativeReader } from '../input/native-reader.ts';
import type { RawRead } from '../input/types.ts';
import { createWebNfcSource } from '../input/web-nfc-source.ts';
import { createWedgeSource, WedgeFields } from '../input/wedge-source.ts';
import { decodeActive } from '../machine/derive.ts';
import { createDirectionPin } from '../machine/direction-pin.ts';
import { initialState } from '../machine/initial-state.ts';
import { createScanStore } from '../machine/store.ts';
import type { OfflineController } from '../offline/controller.ts';
import type { QueueView } from '../offline/queue-view.ts';
import { hydrateUnsure } from '../offline/unsure-store.ts';
import { reconcileScope, wipeLocal } from '../offline/wipe.ts';
import { sound } from '../sound/player.ts';
import type { Announcement } from '../ui/live-announcer.tsx';
import { cameraDisabledFor } from './camera-disabled.ts';
import { chipText } from './chip-text.ts';
import { customerBrandingOf } from './customer-branding.ts';
import { loadDevicePrefs } from './device-prefs.ts';
import { draftPortOf } from './draft-port.ts';
import { focusTarget } from './focus-target.ts';
import { scanId } from './id.ts';
import { openLocalStores } from './local-stores.ts';
import { getNativeCapabilities, setNativeCapabilities } from './native-capabilities.ts';
import { connectOffline } from './offline-runtime.ts';
import { createWakeLock } from './wake-lock.ts';

export async function createRuntime(
  session: ScanSession,
  api: ScanApi,
  video: () => HTMLVideoElement | null,
  announce: (message: Announcement) => void,
) {
  const clock = {
    now: Date.now,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const {
    db,
    unsure,
    stores: localStores,
  } = await openLocalStores((text) => announce({ text, polite: true, n: Date.now() }));
  let scanner = session.scanner;
  const cameraDisabled = () => cameraDisabledFor(session, scanner);
  try {
    await reconcileScope(localStores, {
      scannerId: scanner?.id ?? 'admin',
      mode: scanner?.mode ?? getMode(),
      eventId: session.event?.id ?? null,
    });
  } catch {
    announce({
      text: 'Local storage unavailable. Keep this page open.',
      polite: true,
      n: Date.now(),
    });
  }
  const state = initialState(clock.now());
  state.counts = session.counts;
  state.posture = scanner?.settings.flow === 'choose' ? 'desk' : 'door';
  state.prefs.sound = sound.enabled();
  Object.assign(state.prefs, loadDevicePrefs());
  state.reader.kind =
    scanner?.settings.reader === 'nfc'
      ? 'nfc'
      : scanner?.settings.reader === 'barcode'
        ? 'barcode'
        : 'none';
  state.camera = cameraDisabled() ? 'disabled' : 'off';
  state.offline.mode = scanner ? offlineModeOf(scanner.settings) : 'stop';
  let offline: OfflineController | null = null;
  if (scanner) state.unsure = await hydrateUnsure(unsure, scanner.id, clock.now());
  const fields = new WedgeFields();
  const webNfc = createWebNfcSource();
  const tagEnded = new Set<(why: 'cancelled' | 'timeout') => void>();
  let tagReading = false;
  const pin = createDirectionPin(clock);
  const notice = (text: string, polite = true) => announce({ text, polite, n: Date.now() });
  let native: ReturnType<typeof connectNativeReader> = null;
  let vasFallbackNoticeShown = false;
  const wakeLock = createWakeLock(notice);
  const camera = createCamera(
    video,
    () => (session.formats.length ? session.formats : ['qr']),
    (read) => emit(read),
    (s) => store.dispatch({ type: 'camera', status: s }),
  );
  const store = createScanStore(
    {
      api,
      draft: draftPortOf(session, api),
      tags: tagsPortOf(api),
      toFail,
      camera,
      clock,
      ids: { id: scanId },
      pin,
      unsure,
      offline: { decide: (key, input, unverified) => void offline?.decide(key, input, unverified) },
      scannerId: () => scanner?.id ?? null,
      base: () => ({}),
      audio: { unlock: sound.unlock },
      sound,
      wake: wakeLock,
      announce: notice,
      focus: focusTarget,
      chip: (chip) => notice(chipText(chip)),
      celebrate: () => undefined,
      wipe: () => {
        void wipeLocal(localStores).catch(() => notice('Could not clear stored scans.', false));
      },
    },
    state,
  );
  offline = connectOffline({
    scanner,
    api,
    stores: localStores,
    clock,
    store,
    session: () => session,
  });
  const bus = createBus({
    dispatch: store.dispatch,
    clock,
    ids: { id: scanId },
    origins: [location.origin],
  });
  // The hardware panel's Test: every source's reads go nowhere while it is open.
  let held = false;
  const idle = ({ state: s } = store.getSnapshot()) => !s.started || s.block || document.hidden;
  const emit = (read: RawRead) => {
    if (held || idle()) return null;
    const input = bus.emit(read);
    const loop = store.getSnapshot().state.loop;
    return 'input' in loop && loop.input.id === input.id ? input.id : null;
  };
  const syncCameraMode = () => {
    const current = store.getSnapshot().state;
    if (cameraDisabled()) {
      if (current.camera !== 'disabled') {
        camera.stop();
        store.dispatch({ type: 'camera', status: 'disabled' });
      }
    } else if (current.camera === 'disabled') {
      store.dispatch({ type: 'camera', status: 'off' });
      if (current.started) camera.start();
    }
  };
  native = connectNativeReader({
    read(read) {
      if (!held && idle()) notice('Not scanning right now. Resume, then scan again.', false);
      return emit(read);
    },
    cancelled(id) {
      const l = store.getSnapshot().state.loop;
      if ((l.s === 'checking' || l.s === 'applying') && l.input.id === id)
        store.dispatch({ type: 'fail', key: l.key, error: 'timeout' });
    },
    unsupported: () => notice('Wallet pass verification is unavailable. Scan the barcode.', false),
    tagEnded(why) {
      for (const listener of tagEnded) listener(why);
    },
    capabilities(value) {
      void setNativeCapabilities(value).then(() => {
        // Android reads tags continuously: ask for them with every start from now on.
        const nfc = getNativeCapabilities()?.nfc;
        const wants = nfc?.continuous === true && nfc.formats.includes('tag-uid');
        if (wants !== tagReading) {
          tagReading = wants;
          native?.setTagReading(wants);
          const { started, block } = store.getSnapshot().state;
          if (started && !block && !document.hidden) native?.start();
        }
        const vasOff = getNativeCapabilities()?.vas.available === false;
        if (!vasFallbackNoticeShown && scanner?.settings.reader === 'nfc' && vasOff) {
          notice('Wallet pass verification is unavailable. Scan the barcode.', false);
          vasFallbackNoticeShown = true;
        }
        syncCameraMode();
      });
    },
  });
  native?.customerBranding(customerBrandingOf(session));
  const stopWedge = createWedgeSource({
    clock,
    fields,
    eventTime: true,
    onFocus: (focused) => store.dispatch({ type: 'focus', focused }),
    onBadLayout: (badLayout) => store.dispatch({ type: 'reader', reader: { badLayout } }),
  }).start((read) => emit(read));
  const stopWebNfc = webNfc.start((read) => emit(read));
  const onOnline = () => {
    store.dispatch({ type: 'online', online: navigator.onLine });
    if (navigator.onLine) offline?.kick();
  };
  const onVisible = () => {
    store.dispatch({ type: 'visible', visible: !document.hidden });
    if (!document.hidden) offline?.kick();
    if (!document.hidden) {
      const current = store.getSnapshot().state;
      if (current.started && !current.block && current.loop.s !== 'paused') native?.start();
    }
    if (document.hidden) {
      camera.stop();
      if (store.getSnapshot().state.camera !== 'disabled')
        store.dispatch({ type: 'camera', status: 'off' });
      native?.stop();
      wakeLock.release();
    }
  };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOnline);
  document.addEventListener('visibilitychange', onVisible);
  let pending: ScanSession | null = null;
  const applyPending = () => {
    const next = pending;
    const current = store.getSnapshot().state;
    if (!next?.scanner || current.loop.s !== 'ready' || current.overlay) return;
    pending = null;
    session = next;
    scanner = next.scanner;
    store.configure(scanner.settings, next.counts);
    syncCameraMode();
  };
  const unsubscribe = store.subscribe(() => {
    applyPending();
    const s = store.getSnapshot().state;
    // Keep initialization progressing while session/count updates arrive before the first frame.
    const warming =
      s.camera === 'starting' && decodeActive({ ...s, camera: 'live' }, !document.hidden);
    if (warming || decodeActive(s, !document.hidden)) camera.resume();
    else camera.pause();
    if (s.loop.s === 'checking' || s.loop.s === 'applying')
      native?.customerStatus('checking', s.loop.input.id);
    if (s.loop.s === 'verdict') {
      const outcome =
        !s.loop.outcome.local && s.loop.outcome.kind === 'ok'
          ? 'accepted'
          : s.loop.outcome.kind === 'refused'
            ? 'rejected'
            : 'error';
      native?.result(s.loop.input.id, outcome);
      const displayStatus =
        outcome === 'error'
          ? 'failed'
          : outcome === 'accepted' && s.loop.outcome.checkIn?.direction === 'out'
            ? 'checkedOut'
            : outcome;
      native?.customerStatus(displayStatus, s.loop.input.id);
    }
    if (s.loop.s === 'ready' || s.loop.s === 'paused') native?.customerStatus('ready');
    if (s.block) {
      camera.stop();
      native?.stop();
    }
  });
  return {
    store,
    pin,
    clear: () => wipeLocal(localStores),
    /** Send what is queued now: the shift sheet's Sync now. */
    syncNow: () => offline?.kick(),
    /** What is saved on the device and waiting to sync, for the shift sheet. */
    queueRows: (): Promise<QueueView[]> => offline?.queueRows() ?? Promise.resolve([]),
    rollCallQueue: localStores.meta,
    fields,
    emit,
    checkIn: store.checkIn,
    camera,
    readNfc() {
      native?.readNfc();
    },
    /** Opens the system sheet for one tag (iPhone, iPad). False when the app cannot. */
    readTag(): boolean {
      return native?.tagRead(TAG_EXTRA_COPY.tapToReadPrompt) != null;
    },
    cancelTag() {
      native?.tagCancel();
    },
    announce: notice,
    hold(on: boolean) {
      held = on;
    },
    webNfc,
    onTagEnded(listener: (why: 'cancelled' | 'timeout') => void) {
      tagEnded.add(listener);
      return () => void tagEnded.delete(listener);
    },
    update(next: ScanSession) {
      native?.customerBranding(customerBrandingOf(next));
      pending = next;
      applyPending();
      offline?.rescope();
    },
    start() {
      store.dispatch({ type: 'start' });
      native?.start();
    },
    resume() {
      store.dispatch({ type: 'resume' });
      native?.start();
    },
    dispose() {
      unsubscribe();
      offline?.dispose();
      stopWedge();
      stopWebNfc();
      native?.dispose();
      camera.stop();
      wakeLock.release();
      store.dispose();
      pin.dispose();
      db?.close();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
    },
  };
}
export type ScanRuntime = Awaited<ReturnType<typeof createRuntime>>;
