import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { connectNativeReader } from '../input/native-reader.ts';
import type { RawRead } from '../input/types.ts';
import type { ScanState } from '../machine/types.ts';
import { customerBrandingOf } from './customer-branding.ts';
import { setHapticSender } from './haptics.ts';
import { getNativeCapabilities, setNativeCapabilities } from './native-capabilities.ts';

interface Deps {
  session: () => ScanSession;
  emit(read: RawRead): string | null;
  held(): boolean;
  idle(): boolean;
  notice(text: string, polite?: boolean): void;
  snapshot(): { state: ScanState };
  nfcReader(): boolean;
  syncCameraMode(): void;
  tagEnded: Set<(why: 'cancelled' | 'timeout') => void>;
  fail(key: string): void;
}

/** The app bridge: reads in, verdicts and customer display status out. Null outside a native shell. */
export function createNativeRuntime(d: Deps) {
  let tagReading = false;
  let vasFallbackNoticeShown = false;
  let native: ReturnType<typeof connectNativeReader> = null;
  setHapticSender(null);
  const emitNative = (read: RawRead) => {
    if (!d.held() && d.idle()) d.notice('Not scanning right now. Resume, then scan again.', false);
    return d.emit(read);
  };
  native = connectNativeReader({
    read: emitNative,
    cancelled(id) {
      const l = d.snapshot().state.loop;
      if ((l.s === 'checking' || l.s === 'applying') && l.input.id === id) d.fail(l.key);
    },
    unsupported: () =>
      d.notice('Wallet pass verification is unavailable. Scan the barcode.', false),
    tagEnded(why) {
      for (const listener of d.tagEnded) listener(why);
    },
    settleReady(on) {
      setHapticSender(on && native ? native.haptic : null);
    },
    capabilities(value) {
      void setNativeCapabilities(value).then(() => {
        // Android reads tags continuously: ask for them with every start from now on.
        const nfc = getNativeCapabilities()?.nfc;
        const wants = nfc?.continuous === true && nfc.formats.includes('tag-uid');
        if (wants !== tagReading) {
          tagReading = wants;
          native?.setTagReading(wants);
          const { started, block } = d.snapshot().state;
          if (started && !block && !document.hidden) native?.start();
        }
        const vasOff = getNativeCapabilities()?.vas.available === false;
        if (!vasFallbackNoticeShown && d.nfcReader() && vasOff) {
          d.notice('Wallet pass verification is unavailable. Scan the barcode.', false);
          vasFallbackNoticeShown = true;
        }
        d.syncCameraMode();
      });
    },
  });
  native?.customerBranding(customerBrandingOf(d.session()));
  return {
    native,
    /** Reflect the machine on the app: customer display status, the verdict, stop on block. */
    sync(s: ScanState) {
      if (!native) return;
      if (s.loop.s === 'checking' || s.loop.s === 'applying')
        native.customerStatus('checking', s.loop.input.id);
      if (s.loop.s === 'verdict') {
        const outcome =
          !s.loop.outcome.local && s.loop.outcome.kind === 'ok'
            ? 'accepted'
            : s.loop.outcome.kind === 'refused'
              ? 'rejected'
              : 'error';
        native.result(s.loop.input.id, outcome);
        const displayStatus =
          outcome === 'error'
            ? 'failed'
            : outcome === 'accepted' && s.loop.outcome.checkIn?.direction === 'out'
              ? 'checkedOut'
              : outcome;
        native.customerStatus(displayStatus, s.loop.input.id);
      }
      if (s.loop.s === 'ready' || s.loop.s === 'paused') native.customerStatus('ready');
      if (s.block) native.stop();
    },
    dispose() {
      setHapticSender(null);
      native?.dispose();
    },
  };
}
