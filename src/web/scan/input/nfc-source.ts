/** The NFC source: a **Hold near** tap asks the bridge for one read and puts it on the bus. */
import type { NfcBridge } from './nfc-bridge.ts';
import type { InputSource, RawRead } from './types.ts';

export interface NfcSource extends InputSource {
  /** One system-sheet read. Cancel and timeout emit nothing. */
  holdNear(): Promise<void>;
}

export function createNfcSource(bridge: NfcBridge): NfcSource {
  let emit: ((read: RawRead) => void) | null = null;
  return {
    method: 'nfc',
    start(next) {
      emit = next;
      return () => {
        emit = null;
      };
    },
    async holdNear() {
      if (!emit) return;
      try {
        const { message } = await bridge.read();
        emit?.({ method: 'nfc', code: message });
      } catch {
        // The person dismissed the sheet or it timed out: there is no read to report.
      }
    },
  };
}
