/**
 * The command runner: executes what the reducer asks for over the injected ports, and feeds the
 * results back as events. It owns the in-flight requests, their timeouts and the unsure retries.
 */
import type { ScanInput } from '../input/types.ts';
import { SCAN_TIMING } from '../timing.ts';
import type { ActBody, ResolveBody, ScanDeps, UnsureRow } from './ports.ts';
import type { Cmd, Draft, ScanEvent, ScanOutcome, ScanState, Unsure } from './types.ts';

type Wire = Pick<ScanInput, 'code' | 'passId' | 'method'>;

export interface Host {
  state(): ScanState;
  dispatch(event: ScanEvent): void;
  beat(beat: Extract<Cmd, { c: 'beat' }>['beat']): void;
}

const wireOf = (i: ScanInput | Wire): Wire => ({
  ...(i.code !== undefined ? { code: i.code } : {}),
  ...(i.passId !== undefined ? { passId: i.passId } : {}),
  method: i.method,
});

const inputBody = (w: Wire): ResolveBody['input'] =>
  w.passId ? { passId: w.passId, method: 'manual' } : { code: w.code ?? '', method: w.method };

/** The draft a retry resends: the same action, never the Manager's PIN. */
function withoutPin(draft: Draft | 'auto'): Draft {
  if (draft === 'auto') return { actionId: 'auto', amount: null };
  const { approval: _pin, ...rest } = draft;
  return rest;
}

export function createRunner(deps: ScanDeps, host: Host) {
  /** Requests on the wire, by key. */
  const inflight = new Set<string>();
  /** The request behind an unsure entry, kept so a retry resends the same body. */
  const bodies = new Map<string, { wire: Wire; draft: Draft }>();
  let persisted: UnsureRow[] | null = null;

  function actBody(key: string, wire: Wire, draft: Draft | 'auto'): ActBody {
    const state = host.state();
    const d = draft === 'auto' ? null : draft;
    return {
      idempotencyKey: key,
      input: inputBody(wire),
      clientTs: deps.clock.now(),
      ...deps.base(),
      actionId: d ? d.actionId : 'auto',
      ...(d && d.amount !== null ? { amount: d.amount } : {}),
      ...(state.scope.direction === 'out' ? { direction: 'out' as const } : {}),
      ...(d?.overrideOf ? { overrideOf: d.overrideOf } : {}),
      ...(d?.confirmed ? { confirmed: true } : {}),
      ...(d?.approval ? { approval: d.approval } : {}),
    };
  }

  /** Sends one request. Timeout aborts it; the answer or failure becomes an event. */
  function send(
    key: string,
    call: (signal: AbortSignal) => Promise<unknown>,
    onAnswer: (outcome: ScanOutcome) => ScanEvent,
  ): void {
    if (inflight.has(key)) return;
    inflight.add(key);
    const ac = new AbortController();
    let settled = false;
    const timer = deps.clock.setTimeout(() => {
      if (settled) return;
      settled = true;
      inflight.delete(key);
      ac.abort();
      host.dispatch({ type: 'fail', key, error: 'timeout' });
    }, SCAN_TIMING.LOOKUP_TIMEOUT);
    call(ac.signal).then(
      (outcome) => {
        if (settled) return;
        settled = true;
        inflight.delete(key);
        deps.clock.clearTimeout(timer);
        host.dispatch(onAnswer(outcome as ScanOutcome));
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        inflight.delete(key);
        deps.clock.clearTimeout(timer);
        const info = deps.toFail(error);
        host.dispatch({ type: 'fail', key, ...info });
      },
    );
  }

  const answerOf =
    (key: string) =>
    (outcome: ScanOutcome): ScanEvent => ({
      type: 'answer',
      key,
      outcome,
      ...(outcome.replay ? { replay: true } : {}),
    });

  function keep(entry: Unsure, wire: Wire) {
    const scannerId = deps.scannerId();
    if (scannerId) {
      const row: UnsureRow = { entry, scannerId, input: wire };
      persisted = null;
      deps.unsure.put(row).catch((error: unknown) => {
        // Persistence is best effort: the retry loop keeps working in memory.
        void error;
      });
    }
  }

  function run(cmds: Cmd[]): void {
    for (const cmd of cmds) {
      switch (cmd.c) {
        case 'resolve': {
          const body: ResolveBody = {
            idempotencyKey: cmd.key,
            input: inputBody(wireOf(cmd.input)),
            clientTs: deps.clock.now(),
            ...deps.base(),
          };
          send(cmd.key, (signal) => deps.api.resolve(body, { signal }), answerOf(cmd.key));
          break;
        }
        case 'act': {
          const wire = wireOf(cmd.input);
          const body = actBody(cmd.key, wire, cmd.draft);
          // A PIN is never kept: strip it before the request can become an unsure retry.
          bodies.set(cmd.key, { wire, draft: withoutPin(cmd.draft) });
          send(cmd.key, (signal) => deps.api.act(body, { signal }), answerOf(cmd.key));
          break;
        }
        case 'undo':
          send(
            cmd.key,
            (signal) => deps.api.undo(cmd.scanId, { idempotencyKey: cmd.key }, { signal }),
            (outcome) => ({ type: 'undone', key: cmd.key, outcome }),
          );
          break;
        case 'unsure.keep': {
          const body = bodies.get(cmd.entry.key);
          if (body) keep({ ...cmd.entry, draft: body.draft }, body.wire);
          break;
        }
        case 'unsure.drop':
          bodies.delete(cmd.key);
          persisted = null;
          deps.unsure.remove(cmd.key).catch((error: unknown) => void error);
          break;
        case 'offline.decide':
          // Offline check-in is CC.7: until then the reducer never emits this.
          break;
        case 'camera':
          deps.camera[cmd.op]();
          break;
        case 'wake':
          if (cmd.op === 'request') deps.wake.request();
          else deps.wake.release();
          break;
        case 'audio':
          deps.audio.unlock();
          break;
        case 'sound':
          if (host.state().prefs.sound) deps.sound.play(cmd.tone);
          break;
        case 'beat':
          host.beat(cmd.beat);
          break;
        case 'announce':
          deps.announce(cmd.text, cmd.polite);
          break;
        case 'focus':
          deps.focus(cmd.target);
          break;
        case 'chip':
          deps.chip(cmd.chip);
          break;
        case 'celebrate':
          deps.celebrate();
          break;
        case 'card.rise':
        case 'card.tuck':
        case 'card.swap':
          // The view animates the layer; its timers are the reducer's deadlines.
          break;
      }
    }
  }

  async function loadPersisted(): Promise<UnsureRow[]> {
    persisted ??= await deps.unsure.all().catch(() => []);
    return persisted;
  }

  /** Resends every entry that still has no answer, with its original key and body. */
  async function retryUnsure(): Promise<void> {
    const state = host.state();
    if (!state.online) return;
    for (const entry of state.unsure) {
      if (entry.state !== 'retrying' || inflight.has(entry.key)) continue;
      let body = bodies.get(entry.key);
      if (!body) {
        const row = (await loadPersisted()).find((r) => r.entry.key === entry.key);
        if (row) {
          body = { wire: row.input, draft: entry.draft };
          bodies.set(entry.key, body);
        }
      }
      if (!body) continue;
      const req = actBody(entry.key, body.wire, body.draft);
      send(entry.key, (signal) => deps.api.act(req, { signal }), answerOf(entry.key));
    }
  }

  return { run, retryUnsure, inflight };
}
