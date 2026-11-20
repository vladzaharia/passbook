import { useCallback, useEffect, useReducer, useRef } from 'react';
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
import { focusHeading, focusSearch } from './workspace/focus.ts';

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
  const activity = useSessionActivity(api);
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
  const problems = problemsOf(activity.items, clock, actions.settled);
  const last = state.recent[0];
  const undoId =
    last?.scanId && last.undoable && (last.outcome.undoUntil ?? 0) > Date.now()
      ? last.scanId
      : null;
  const previewed = results[ui.highlight];
  const preview: RecordRef | null =
    searching(ui) && previewed ? { kind: 'pass', passId: previewed.passId, from: 'search' } : null;
  const record = preview ?? ui.record;
  const recordOpen = live || record !== null;

  // Fresh results highlight the first row, so the record previews it and Enter opens it.
  useEffect(() => send({ t: 'highlight', index: found?.items.length ? 0 : -1 }), [found]);

  const latest = useRef({ ui, results, undoId });
  latest.current = { ui, results, undoId };

  const open = useCallback((passId: string, from: From) => {
    send({ t: 'open', ref: { kind: 'pass', passId, from } });
    requestAnimationFrame(focusHeading);
  }, []);
  const undo = useCallback((scanId: string) => machine({ type: 'undo', scanId }), [machine]);
  const close = useCallback(() => {
    send({ t: 'close' });
    machine({ type: 'dismiss' });
    requestAnimationFrame(focusHeading);
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
      send({ t: 'close' });
      requestAnimationFrame(() => {
        // Left where it was, unless that control went with the record it belonged to.
        const gone = !document.activeElement || document.activeElement === document.body;
        if (focus === 'heading' || gone) focusHeading();
      });
    }
    wasLive.current = live;
  }, [live]);
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
    recordOpen,
    live,
    allowPeople,
    recordKeys,
    undoable: undoId !== null,
    clock,
  };
}
