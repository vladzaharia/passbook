/**
 * The one bus every source goes through (AC 2.1): normalize, stamp with an id, a time and a
 * signature, then dispatch `read`. Sources never call the network.
 */
import type { ClockPort } from '../machine/ports.ts';
import type { ScanEvent } from '../machine/types.ts';
import { normalizeRead } from './normalize.ts';
import type { RawRead, ScanInput } from './types.ts';

export interface BusDeps {
  dispatch(event: ScanEvent): void;
  clock: Pick<ClockPort, 'now'>;
  ids: { id(): string };
  /** Origins whose `/p/` and `/b/` links are ours. */
  origins: readonly string[];
}

export function createBus(deps: BusDeps) {
  return {
    emit(raw: RawRead): ScanInput {
      const n = normalizeRead(raw, deps.origins);
      const input: ScanInput = {
        method: raw.method,
        ...(n.code !== undefined ? { code: n.code } : {}),
        ...(n.passId !== undefined ? { passId: n.passId } : {}),
        ...(raw.format ? { format: raw.format } : {}),
        ...(raw.box ? { box: raw.box } : {}),
        id: deps.ids.id(),
        at: deps.clock.now(),
        sig: n.sig,
        ...(n.local ? { local: n.local } : {}),
      };
      deps.dispatch({ type: 'read', input });
      return input;
    },
  };
}
