import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
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
import { openScanDb } from '../offline/db.ts';
import {
  createIdbUnsureStore,
  createMemoryUnsureStore,
  hydrateUnsure,
} from '../offline/unsure-store.ts';
import {
  createIdbKeyValue,
  createMemoryKeyValue,
  reconcileScope,
  wipeLocal,
} from '../offline/wipe.ts';
import { sound } from '../sound/player.ts';
import type { Announcement } from '../ui/live-announcer.tsx';
import { customerBrandingOf } from './customer-branding.ts';
import { focusTarget } from './focus-target.ts';
import { scanId } from './id.ts';
import { getNativeCapabilities, setNativeCapabilities } from './native-capabilities.ts';
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
  let db: IDBDatabase | null = null;
  let unsure = createMemoryUnsureStore();
  try {
    db = await openScanDb();
    unsure = createIdbUnsureStore(db);
  } catch {
    announce({
      text: 'Storage unavailable. Keep this page open until all scans are confirmed.',
      polite: true,
      n: Date.now(),
    });
  }
  const localStores = {
    unsure,
    queue: db ? createIdbKeyValue(db, 'queue') : createMemoryKeyValue(),
    roster: db ? createIdbKeyValue(db, 'roster') : createMemoryKeyValue(),
    meta: db ? createIdbKeyValue(db, 'meta') : createMemoryKeyValue(),
  };
  let scanner = session.scanner;
  const hasDuoLayout = () => {
    const layout =
      getNativeCapabilities()?.layout ?? session.workspace?.device.capabilities?.native?.layout;
    return layout?.posture === 'unfolded' || layout?.posture === 'half-folded';
  };
  const cameraDisabled = () => {
    if (hasDuoLayout()) return false;
    if (session.workspace?.device.effectiveSurface === 'operator') return true;
    const native = getNativeCapabilities() ?? session.workspace?.device.capabilities?.native;
    if (scanner?.settings.reader === 'barcode') {
      return (
        session.workspace?.device.capabilities?.nativeBarcode ?? native?.platform === 'android'
      );
    }
    return scanner?.settings.reader === 'nfc' && (native?.vas.available ?? false);
  };
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
  state.reader.kind =
    scanner?.settings.reader === 'nfc'
      ? 'nfc'
      : scanner?.settings.reader === 'barcode'
        ? 'barcode'
        : 'none';
  state.camera = cameraDisabled() ? 'disabled' : 'off';
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
      tags: tagsPortOf(api),
      toFail,
      camera,
      clock,
      ids: { id: scanId },
      pin,
      unsure,
      scannerId: () => scanner?.id ?? null,
      base: () => ({}),
      audio: { unlock: sound.unlock },
      sound,
      wake: wakeLock,
      announce: notice,
      focus: focusTarget,
      chip: () => notice('Just scanned'),
      celebrate: () => undefined,
      wipe: () => {
        void wipeLocal(localStores).catch(() => notice('Could not clear stored scans.', false));
      },
    },
    state,
  );
  const bus = createBus({
    dispatch: store.dispatch,
    clock,
    ids: { id: scanId },
    origins: [location.origin],
  });
  const emit = (read: RawRead) => {
    const current = store.getSnapshot().state;
    if (!current.started || current.block || document.hidden) return null;
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
    read: emit,
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
      setNativeCapabilities(value);
      // Android reads tags continuously: ask for them with every start from now on.
      const nfc = getNativeCapabilities()?.nfc;
      const wants = nfc?.continuous === true && nfc.formats.includes('tag-uid');
      if (wants !== tagReading) {
        tagReading = wants;
        native?.setTagReading(wants);
        const now = store.getSnapshot().state;
        if (now.started && !now.block && !document.hidden) native?.start();
      }
      if (
        !vasFallbackNoticeShown &&
        scanner?.settings.reader === 'nfc' &&
        getNativeCapabilities()?.vas.available === false
      ) {
        notice('Wallet pass verification is unavailable. Scan the barcode.', false);
        vasFallbackNoticeShown = true;
      }
      syncCameraMode();
    },
  });
  native?.customerBranding(customerBrandingOf(session));
  const stopWedge = createWedgeSource({
    clock,
    fields,
    onFocus: (focused) => store.dispatch({ type: 'focus', focused }),
    onBadLayout: (badLayout) => store.dispatch({ type: 'reader', reader: { badLayout } }),
  }).start((read) => emit(read));
  const stopWebNfc = webNfc.start((read) => emit(read));
  const onOnline = () => store.dispatch({ type: 'online', online: navigator.onLine });
  const onVisible = () => {
    store.dispatch({ type: 'visible', visible: !document.hidden });
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
    webNfc,
    onTagEnded(listener: (why: 'cancelled' | 'timeout') => void) {
      tagEnded.add(listener);
      return () => void tagEnded.delete(listener);
    },
    update(next: ScanSession) {
      native?.customerBranding(customerBrandingOf(next));
      pending = next;
      applyPending();
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
