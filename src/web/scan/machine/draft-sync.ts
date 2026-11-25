/**
 * Shows the amount under review on the customer screens that follow this scanner. It watches the
 * machine, never drives it: a failed or slow draft call changes nothing the desk does.
 */
import { type DraftHealth, draftHealth } from './draft-health.ts';
import type { ScanDeps } from './ports.ts';
import type { Cmd, ScanState } from './types.ts';

/** Typing settles for this long before a draft goes: at most four a second. */
const DEBOUNCE_MS = 250;
/** The open draft is sent again this often, so a screen that missed a cancel drops it on its own. */
const RESEND_MS = 15_000;

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

export function createDraftSync(deps: ScanDeps, health: DraftHealth = draftHealth) {
  const port = deps.draft;
  /** The read the last server `resolve` was sent for: its key is the draft's `ref`. */
  let read: { sig: string; key: string } | null = null;
  let timer: unknown = null;
  let resend: unknown = null;
  /** The read whose ready card the screens may be showing: set by a draft, cleared when the read ends. */
  let anchor: string | null = null;
  let shown: Want | null = null;
  let pending: Want | null = null;
  let inflight = false;
  /** A clear sent while a draft was on the wire is sent again once it lands. */
  let clearAfter: { ref: string; keep: boolean } | null = null;
  /** The read a Confirm sent: forgotten on an ok verdict, cleared on any other way out. */
  let committing: string | null = null;
  const gone = new AbortController();

  const stop = (handle: unknown) => {
    if (handle !== null) deps.clock.clearTimeout(handle);
    return null;
  };

  /** The money field staff are on: a single currency value, an amount to choose, take or add. */
  function moneyOf(s: ScanState): { ref: string; actionId: string; amount: number | null } | null {
    if (!port || !s.online || deps.scannerId() === null) return null;
    const l = s.loop;
    if (l.s !== 'member' && l.s !== 'reviewing') return null;
    const draft = l.s === 'member' ? l.picker : l.draft;
    if (!draft || l.input.passId !== undefined || l.input.local) return null;
    if (!read || read.sig !== l.input.sig) return null;
    const action = l.card.actions.find((a) => a.id === draft.actionId);
    const only = l.card.values.length === 1 ? l.card.values[0] : undefined;
    const ranged = action?.amount && !('fixed' in action.amount);
    if (!action || (action.kind !== 'take' && action.kind !== 'add')) return null;
    if (only?.format !== 'currency' || !ranged) return null;
    const amount = draft.amount !== null && draft.amount > 0 ? draft.amount : null;
    return { ref: read.key, actionId: draft.actionId, amount };
  }

  function wantOf(s: ScanState): Want | null {
    const m = moneyOf(s);
    return m && m.amount !== null ? { ref: m.ref, actionId: m.actionId, amount: m.amount } : null;
  }

  function counted(call: Promise<{ screens: number }>) {
    return call.then(
      (result) => health.setOnScreen(result.screens >= 1),
      () => {
        // A draft is a courtesy: a failure is counted, never retried, never shown to staff.
        health.failed();
        health.setOnScreen(false);
      },
    );
  }

  function armResend() {
    resend = stop(resend);
    resend = deps.clock.setTimeout(() => {
      resend = null;
      if (!shown) return;
      if (inflight) armResend();
      else {
        pending = shown;
        send();
      }
    }, RESEND_MS);
  }

  function send() {
    timer = null;
    const w = pending;
    if (!w || !port) return;
    if (inflight) return; // the latest waits for the call on the wire
    pending = null;
    inflight = true;
    shown = w;
    void counted(port.put(w, { signal: gone.signal })).then(async () => {
      if (clearAfter) {
        // Still on the wire until the trailing clear settles, so a new PUT cannot overtake it.
        const c = clearAfter;
        clearAfter = null;
        await counted(port.clear(c.ref, c.keep, { signal: gone.signal }));
      }
      inflight = false;
      if (pending) send();
      else if (shown) armResend();
    });
  }

  /** Clears at once. `keep`: only the draft, the ready card stays. */
  function clear(ref: string, keep: boolean) {
    timer = stop(timer);
    resend = stop(resend);
    pending = null;
    shown = null;
    health.setOnScreen(false);
    if (!port) return;
    if (inflight) clearAfter = { ref, keep };
    void counted(port.clear(ref, keep, { signal: gone.signal }));
  }

  return {
    /** Called after every event: `cmds` are what the reducer asked for. */
    observe(after: ScanState, cmds: readonly Cmd[]) {
      for (const c of cmds) if (c.c === 'resolve') read = { sig: c.input.sig, key: c.key };
      const loop = after.loop;
      if (committing !== null && loop.s !== 'applying') {
        const ref = committing;
        committing = null;
        if (!(loop.s === 'verdict' && loop.outcome.kind === 'ok')) clear(ref, false);
      }
      const want = wantOf(after);
      if (anchor !== null) {
        const onRead = (loop.s === 'member' || loop.s === 'reviewing') && read?.key === anchor;
        if (loop.s === 'applying' && read?.key === anchor) {
          // The commit follows a Confirm: an ok verdict forgets the draft, anything else clears it.
          committing = anchor;
          anchor = null;
          timer = stop(timer);
          resend = stop(resend);
          pending = null;
          shown = null;
        } else if (!onRead) {
          clear(anchor, false);
          anchor = null;
        } else if (!want && (pending ?? shown)) clear(anchor, true);
      }
      if (!want || same(want, pending ?? shown)) return;
      anchor = want.ref;
      pending = want;
      timer = stop(timer);
      timer = deps.clock.setTimeout(send, DEBOUNCE_MS);
    },
    dispose() {
      timer = stop(timer);
      resend = stop(resend);
      gone.abort();
    },
  };
}
