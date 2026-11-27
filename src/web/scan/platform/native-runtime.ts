import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { connectNativeReader } from '../input/native-reader.ts';
import {
  departure,
  liveIds,
  onScreen,
  outcomeOf,
  type ReadResult,
  unsentVerdict,
} from '../input/native-settle.ts';
import type { RawRead, ScanInput } from '../input/types.ts';
import { readFate } from '../machine/reduce-read.ts';
import type { ScanState } from '../machine/types.ts';
import { customerBrandingOf } from './customer-branding.ts';
import { setHapticSender } from './haptics.ts';
import { getNativeCapabilities, setNativeCapabilities } from './native-capabilities.ts';

interface Deps {
  session: () => ScanSession;
  /** Puts a read on the bus (the machine's input), without the idle checks. */
  dispatch(read: RawRead): ScanInput;
  now(): number;
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
  /** Every native read gets an answer: tracked by input id, or ended now with why. */
  const emitNative = (read: RawRead): ReadResult => {
    if (d.held()) return { error: true };
    if (d.idle()) {
      d.notice('Not scanning right now. Resume, then scan again.', false);
      return { error: true };
    }
    const before = d.snapshot().state;
    const input = d.dispatch(read);
    if (liveIds(d.snapshot().state).has(input.id)) return { track: input.id };
    return { drop: readFate(before, input, d.now()) === 'duplicate' ? 'duplicate' : 'closed' };
  };
  let prev = d.snapshot().state;
  /** Answer the read on screen, then end tracked reads the machine let go of. */
  const settle = (s: ScanState) => {
    if (!native) return;
    const shown = onScreen(s);
    if (shown) native.result(shown.id, shown.outcome);
    const live = liveIds(s);
    for (const id of native.unanswered()) {
      if (live.has(id)) continue;
      const unsent = unsentVerdict(prev, id);
      if (unsent) native.result(id, unsent);
      else native.dropped(id, departure(prev, id));
    }
  };
  native = connectNativeReader({
    read: emitNative,
    settleNow: () => settle(d.snapshot().state),
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
      settle(s);
      if (s.loop.s === 'checking' || s.loop.s === 'applying')
        native.customerStatus('checking', s.loop.input.id);
      if (s.loop.s === 'verdict') {
        const outcome = outcomeOf(s.loop.outcome);
        const displayStatus =
          outcome === 'error'
            ? 'failed'
            : outcome === 'accepted' && s.loop.outcome.checkIn?.direction === 'out'
              ? 'checkedOut'
              : outcome;
        native.customerStatus(displayStatus, s.loop.input.id);
      }
      if (s.loop.s === 'ready' || s.loop.s === 'paused') native.customerStatus('ready');
      prev = s;
      if (s.block) native.stop();
    },
    dispose() {
      setHapticSender(null);
      native?.dispose();
    },
  };
}
