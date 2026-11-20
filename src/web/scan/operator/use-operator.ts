import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { useNow } from '../../ui/rel-time.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import { useLookup } from '../lookup/use-lookup.ts';
import { useScanMachine } from '../machine/use-scan-machine.ts';
import type { ScanRuntime } from '../platform/runtime.ts';
import { type Command, OPERATOR_VIEWS, type OperatorView } from './keys.ts';
import { useProblemActions } from './lists/let-in.ts';
import { problemsOf } from './lists/problems-model.ts';
import { useSessionActivity } from './lists/use-session-activity.ts';
import {
  INITIAL,
  landingFocus,
  type RecordRef,
  reduceOperator,
  searching,
} from './operator-model.ts';
import { type KeyFacts, useOperatorKeys } from './use-operator-keys.ts';
import {
  focusAfterClose,
  focusHeading,
  focusLost,
  focusSearch,
  rowKeyOfFocus,
  zoneOf,
} from './workspace/focus.ts';

/** True while the machine is working a scan or showing its answer. */
export const scanLive = (loop: { s: string }) =>
  loop.s === 'checking' ||
  loop.s === 'member' ||
  loop.s === 'reviewing' ||
  loop.s === 'applying' ||
  loop.s === 'verdict';

type From = Extract<RecordRef, { kind: 'pass' }>['from'];

/**
 * Everything the workspace decides: which list, what is typed, what is open, and what each key
 * does. The machine still owns scans; this holds the operator's choices and wires the keys.
 */
export function useOperator({
  api,
  runtime,
  session,
}: {
  api: ScanApi;
  runtime: ScanRuntime;
  session: ScanSession;
}) {
  const { state, dispatch: machine } = useScanMachine();
  const [ui, send] = useReducer(reduceOperator, INITIAL);
  const activity = useSessionActivity(api, state.online);
  const opener = useRef<string | null>(null);
  const [missed, setMissed] = useState(false);
  const clock = useNow(30_000);
  const recordKeys = useRef<((command: Command) => boolean) | null>(null);
  const live = scanLive(state.loop);
  const allowPeople = session.scanner?.settings.lookup ?? false;
  const lookup = useLookup(api, true, allowPeople, (code) => {
    setQuery('');
    runtime.emit({ method: 'manual', code });
  });
  const { change, submit } = lookup;
  const setQuery = useCallback(
    (q: string) => {
      change(q);
      setMissed(false);
      send({ t: 'query', q });
    },
    [change],
  );
  const found = lookup.result;
  const results = found?.items ?? [];
  const actions = useProblemActions(
    api,
    session.staff?.name ?? null,
    () => void activity.refresh(),
  );
  // The problems page and the newest scans overlap; a problem settled by a later check-in needs both.
  const everything = useMemo(() => {
    const byId = new Map(
      [...activity.problemItems, ...activity.items].map((item) => [item.id, item]),
    );
    return [...byId.values()].sort((a, b) => b.at - a.at);
  }, [activity.items, activity.problemItems]);
  const problems = problemsOf(everything, clock, actions.settled);
  const last = state.recent[0];
  const undoId =
    last?.scanId && last.undoable && (last.outcome.undoUntil ?? 0) > Date.now()
      ? last.scanId
      : null;
  const previewed = results[ui.highlight];
  // A highlighted hit is shown from the search row, not opened: /resolve is a live row on monitors.
  const preview: RecordRef | null =
    searching(ui) && previewed ? { kind: 'pass', passId: previewed.passId, from: 'preview' } : null;
  const record = ui.record ?? preview;
  const recordOpen = live || record !== null;

  // Fresh results highlight the first row, or the one that was highlighted when it is still there
  // (a scan restoring the field re-runs the search), so the record previews it and Enter opens it.
  const highlighted = useRef<string | null>(null);
  highlighted.current = previewed?.passId ?? highlighted.current;
  useEffect(() => {
    const items = found?.items ?? [];
    const keep = items.findIndex((row) => row.passId === highlighted.current);
    send({ t: 'highlight', index: items.length ? Math.max(0, keep) : -1 });
  }, [found]);

  // `submit` may pick a single hit or a short code on its own. The operator never keeps that state:
  // it opens the hit, or says there was none, and clears it so search keeps working.
  const { picked, back } = lookup;

  const latest = useRef({ ui, results, undoId });
  latest.current = { ui, results, undoId };

  const open = useCallback((passId: string, from: From) => {
    opener.current = from === 'search' ? 'search' : rowKeyOfFocus();
    send({ t: 'open', ref: { kind: 'pass', passId, from } });
    requestAnimationFrame(focusHeading);
  }, []);
  useEffect(() => {
    if (!picked) return;
    const passId = picked.card?.passId;
    back();
    if (passId) open(passId, 'search');
    else setMissed(true);
  }, [picked, back, open]);
  const undo = useCallback(
    (scanId: string) => {
      machine({ type: 'undo', scanId });
      // The Undo button leaves with the refresh: keep the operator where they were.
      requestAnimationFrame(() => {
        if (focusLost() && !focusHeading()) focusSearch(false);
      });
    },
    [machine],
  );
  const close = useCallback(() => {
    const from = opener.current;
    opener.current = null;
    send({ t: 'close' });
    machine({ type: 'dismiss' });
    requestAnimationFrame(() => focusAfterClose(from));
  }, [machine]);
  const changeView = useCallback(
    (view: OperatorView) => {
      change('');
      send({ t: 'view', view });
    },
    [change],
  );

  const run = useCallback(
    (command: Command) => {
      const { ui: u, results: found, undoId: target } = latest.current;
      switch (command.c) {
        case 'focus-search':
          focusSearch(true);
          break;
        case 'clear':
          setQuery('');
          break;
        case 'blur-field':
          focusHeading();
          break;
        case 'close-record':
          close();
          break;
        case 'move':
          send({ t: 'move', by: command.by, count: found.length });
          break;
        case 'open': {
          const row = found[u.highlight];
          if (searching(u) && row) open(row.passId, 'search');
          else submit();
          break;
        }
        case 'undo':
          if (target) undo(target);
          break;
        case 'view':
          changeView(command.view);
          break;
        case 'help':
          send({ t: 'help', open: true });
          break;
        case 'type':
          focusSearch(false);
          setQuery(u.query + command.ch);
          break;
        default:
          recordKeys.current?.(command);
      }
    },
    [close, open, undo, changeView, submit, setQuery],
  );
  const facts = (): KeyFacts => ({
    views: OPERATOR_VIEWS,
    fieldText: latest.current.ui.query.length > 0,
    record: recordOpen,
    rollCall: false,
    walkIn: false,
    undoable: latest.current.undoId !== null,
  });
  useOperatorKeys(facts, run);

  // A scan lands wherever focus is. Focus moves only when nothing was open, and then to the heading.
  const wasLive = useRef(false);
  useEffect(() => {
    if (live && !wasLive.current) {
      const focus = landingFocus(latest.current.ui, false);
      // Someone typing, in the field or a note, keeps their place whatever is open.
      const typing = zoneOf(document.activeElement) !== 'record';
      send({ t: 'close' });
      requestAnimationFrame(() => {
        // Left where it was, unless that control went with the record it belonged to.
        if (typing) return;
        if (focus === 'heading' || focusLost()) focusHeading();
      });
    }
    wasLive.current = live;
  }, [live]);
  // An operator console holds a result until it is closed or the next scan replaces it: no 1.2 s timeout.
  useEffect(() => {
    machine({ type: 'prefs', prefs: { holdResults: true } });
  }, [machine]);
  // This device's own scans and undos show in the list now, not at the next poll.
  const lastScanId = last?.scanId ?? null;
  const lastKind = last?.outcome.kind ?? null;
  const { refresh } = activity;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the newest scan, or its kind, changes
  useEffect(() => {
    void refresh();
  }, [lastScanId, lastKind, refresh]);

  return {
    state,
    ui,
    send,
    lookup,
    results,
    activity,
    problems,
    actions,
    open,
    close,
    undo,
    changeView,
    setQuery,
    record,
    previewRow: previewed ?? null,
    missed,
    recordOpen,
    live,
    allowPeople,
    recordKeys,
    undoable: undoId !== null,
    clock,
  };
}
