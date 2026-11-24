/**
 * Shows the amount under review on the customer screens that follow this scanner. It watches the
 * machine, never drives it: a failed or slow draft call changes nothing the desk does.
 */
import type { ScanDeps } from './ports.ts';
import type { Cmd, Draft, ScanState } from './types.ts';

/** Typing settles for this long before a draft goes, and drafts go at most four a second. */
const DEBOUNCE_MS = 250;

interface Want {
  ref: string;
  actionId: string;
  amount: number;
}

const same = (a: Want | null, b: Want | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.ref === b.ref &&
    a.actionId === b.actionId &&
    a.amount === b.amount);

export function createDraftSync(deps: ScanDeps) {
  const port = deps.draft;
  /** The read the last server `resolve` was sent for: its key is the draft's `ref`. */
  let read: { sig: string; key: string } | null = null;
  let timer: unknown = null;
  let shown: Want | null = null;
  let pending: Want | null = null;
  let lastSentAt = Number.NEGATIVE_INFINITY;
  const gone = new AbortController();

  /** The money amount staff are editing on a read the server answered, or null. */
  function want(s: ScanState): Want | null {
    if (!port || !s.online || deps.scannerId() === null) return null;
    const l = s.loop;
    if (l.s !== 'member' && l.s !== 'reviewing') return null;
    const draft: Draft | null = l.s === 'member' ? l.picker : l.draft;
    if (!draft || draft.amount === null || !(draft.amount > 0)) return null;
    if (l.input.passId !== undefined || l.input.local || !read || read.sig !== l.input.sig)
      return null;
    const kind = l.card.actions.find((a) => a.id === draft.actionId)?.kind;
    if (kind !== 'take' && kind !== 'add') return null;
    return { ref: read.key, actionId: draft.actionId, amount: draft.amount };
  }

  function quiet(call: Promise<unknown>) {
    // A draft is a courtesy: a failure is dropped, never retried, never shown to staff.
    call.catch((error: unknown) => void error);
  }

  function send() {
    timer = null;
    const w = pending;
    pending = null;
    if (!w || !port) return;
    lastSentAt = deps.clock.now();
    shown = w;
    quiet(port.put(w, { signal: gone.signal }));
  }

  function clear(ref: string) {
    if (timer !== null) deps.clock.clearTimeout(timer);
    timer = null;
    pending = null;
    shown = null;
    if (port) quiet(port.clear(ref, { signal: gone.signal }));
  }

  return {
    /** Called after every event: `cmds` are what the reducer asked for. */
    observe(after: ScanState, cmds: readonly Cmd[]) {
      for (const c of cmds) if (c.c === 'resolve') read = { sig: c.input.sig, key: c.key };
      const w = want(after);
      const open = pending ?? shown;
      if (open && (!w || w.ref !== open.ref)) {
        // The commit follows a Confirm; any other way out is a cancel.
        if (after.loop.s === 'applying') {
          if (timer !== null) deps.clock.clearTimeout(timer);
          timer = null;
          pending = null;
          shown = null;
        } else clear(open.ref);
      }
      if (!w || same(w, pending ?? shown)) return;
      pending = w;
      if (timer !== null) deps.clock.clearTimeout(timer);
      const wait = Math.max(DEBOUNCE_MS, lastSentAt + DEBOUNCE_MS - deps.clock.now());
      timer = deps.clock.setTimeout(send, wait);
    },
    dispose() {
      if (timer !== null) deps.clock.clearTimeout(timer);
      gone.abort();
    },
  };
}
