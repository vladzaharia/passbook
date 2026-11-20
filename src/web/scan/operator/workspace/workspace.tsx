import { ArrowLeft } from 'lucide-react';
import { type ReactNode, useMemo } from 'react';
import type { ScanCounts } from '../../../../shared/contracts/scan.ts';
import type { ScanBranding, ScanSession } from '../../../../shared/contracts/scan-session.ts';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import type { ScanApi } from '../../api/scan-api.ts';
import { useScanMachine } from '../../machine/use-scan-machine.ts';
import type { ScanRuntime } from '../../platform/runtime.ts';
import { scanBrandStyle } from '../../platform/scan-branding.tsx';
import { deskOf, resultOf } from '../../result/desk.ts';
import type { Announcement } from '../../ui/live-announcer.tsx';
import { LiveAnnouncer } from '../../ui/live-announcer.tsx';
import { OPERATOR_VIEWS } from '../keys.ts';
import { ActivityView } from '../lists/activity-view.tsx';
import { ProblemsView } from '../lists/problems-view.tsx';
import { RESULT_LIST_ID, resultId, SearchResults } from '../lists/search-results.tsx';
import { searching } from '../operator-model.ts';
import { passIdOf, type RecordContext, RecordPass, RecordScan } from '../record/record.tsx';
import { RecordPreview } from '../record/record-preview.tsx';
import { useOperator } from '../use-operator.ts';
import { CommandField, Kbd, type Readiness } from './command-field.tsx';
import { focusSearch } from './focus.ts';
import { HelpSheet, shortcutsFor } from './help-sheet.tsx';
import { hintsOf } from './hints.ts';
import { IdleView } from './idle-view.tsx';
import { inNowOf, sessionChip } from './session-state.ts';
import { StatusBar } from './status-bar.tsx';
import { TopBar } from './top-bar.tsx';
import { panelId, tabId, ViewTabs } from './view-tabs.tsx';
import './top-bar.css';
import './command.css';
import './record-pane.css';
import './workspace.css';
import '../../ui/scan.css';

export interface WorkspaceProps {
  api: ScanApi;
  runtime: ScanRuntime;
  session: ScanSession;
  counts: ScanCounts;
  branding: ScanBranding | null;
  logoUrl: string | null;
  modeLabel: string;
  /** The device's chips (reader, sync, access, tags) and the test marker, as the capsule shows them. */
  chips: ReactNode;
  testing: ReactNode;
  menu: ReactNode;
  /** A card the record does not draw: a boot, paused, blocked or tag card. A scan's own answer is the record. */
  scanCard: ReactNode;
  /** The tag flow's verbs under its card. */
  dock?: ReactNode;
  announcement: Announcement | null;
  onTitle: () => void;
}

/**
 * The operator's console: a field and a list on the left, the person on the right. Under it the
 * scan machine runs as ever; a scan opens its record without taking the focus from the operator.
 */
export function OperatorWorkspace(props: WorkspaceProps) {
  const { api, runtime, session, counts } = props;
  const op = useOperator({ api, runtime, session });
  const { dispatch: machine, now, view: scanView } = useScanMachine();
  const { state, ui, results } = op;
  const view = ui.view;
  const isSearching = searching(ui);
  const timeZone = session.workspace?.session.timeZone ?? session.scanner?.timeZone;
  const chip = sessionChip(session);
  const readiness: Readiness = !state.online
    ? 'offline'
    : !state.focused || state.loop.s === 'paused'
      ? 'paused'
      : 'ready';
  // A boot or paused card is a record too: on one column it must show over the list.
  const recordOpen = op.recordOpen || Boolean(props.scanCard);
  // One polite region (design 12): a refusal must not interrupt a busy desk. The verdict word comes first.
  const polite = useMemo(
    () => (props.announcement ? { ...props.announcement, polite: true } : null),
    [props.announcement],
  );
  const selectedPassId = op.record?.kind === 'pass' ? op.record.passId : null;
  const hints = hintsOf({
    searching: isSearching,
    record: recordOpen,
    undoable: op.undoable,
    views: OPERATOR_VIEWS.length,
  });
  const shortcuts = shortcutsFor({
    record: recordOpen,
    rollCall: false,
    views: OPERATOR_VIEWS.length,
    walkIn: false,
  });
  const hint =
    isSearching && op.lookup.result === null
      ? op.lookup.busy
        ? 'Searching'
        : 'Type 3 letters'
      : null;
  const list = isSearching ? (
    <SearchResults
      result={op.lookup.result}
      busy={op.lookup.busy}
      missed={op.missed}
      highlight={ui.highlight}
      hint={hint}
      error={op.lookup.error}
      wait={op.lookup.seconds}
      timeZone={timeZone}
      onOpen={(passId) => op.open(passId, 'search')}
    />
  ) : view === 'problems' ? (
    <ProblemsView
      open={op.problems.open}
      resolved={op.problems.resolved}
      selectedPassId={selectedPassId}
      timeZone={timeZone}
      onOpen={(item) => item.passId && op.open(item.passId, 'problems')}
      onLetIn={op.actions.letIn}
      onSeen={op.actions.seen}
    />
  ) : (
    <ActivityView
      items={op.activity.items}
      loaded={op.activity.loaded}
      unavailable={op.activity.unavailable}
      selectedPassId={selectedPassId}
      timeZone={timeZone}
      onOpen={(item) => item.passId && op.open(item.passId, 'activity')}
      onUndo={op.undo}
    />
  );
  const scan = (
    <p className="op-checking" role="status">
      Checking
    </p>
  );
  const result = resultOf(state.loop, counts);
  const ctx: RecordContext = {
    api,
    runtime,
    session,
    timeZone,
    clock: now,
    keys: op.recordKeys,
    machine,
    release: () => op.send({ t: 'close' }),
    type: (text) => {
      focusSearch(false);
      op.setQuery(ui.query + text);
    },
    buddy: result ? scanView.buddy : null,
    showPass: (passId) => {
      machine({ type: 'dismiss' });
      op.open(passId, 'open');
    },
    lookUp: (q) => {
      machine({ type: 'dismiss' });
      op.send({ t: 'close' });
      op.setQuery(q);
      requestAnimationFrame(() => focusSearch(false));
    },
    undo:
      op.undoable && result?.scanId && result.scanId === state.recent[0]?.scanId
        ? () => op.undo(result.scanId ?? '')
        : null,
  };
  const record = props.scanCard ? (
    <div className="op-scan-card">
      {props.scanCard}
      {props.dock}
    </div>
  ) : op.live ? (
    result ? (
      <RecordScan
        ctx={ctx}
        outcome={result}
        passId={passIdOf(state.loop, result)}
        desk={deskOf(state.loop, session, machine)}
      />
    ) : (
      scan
    )
  ) : op.record?.kind === 'pass' && op.record.from === 'preview' ? (
    op.previewRow ? (
      <RecordPreview row={op.previewRow} timeZone={timeZone} />
    ) : null
  ) : op.record?.kind === 'pass' ? (
    <RecordPass key={op.record.passId} ctx={ctx} record={op.record} />
  ) : (
    <IdleView
      facts={{
        items: op.activity.items,
        today: counts.today,
        inNow: inNowOf(counts),
        needYou: op.problems.open.length,
        chip,
        now: op.clock,
        timeZone,
      }}
      keys={shortcuts.filter((row) => ['search', 'undo', 'views', 'help'].includes(row.id))}
      onOpen={(item) => item.passId && op.open(item.passId, 'activity')}
      onUndo={op.undo}
      onProblems={() => op.changeView('problems')}
    />
  );
  const activeResult =
    isSearching && ui.highlight >= 0 && results[ui.highlight] ? resultId(ui.highlight) : undefined;
  return (
    <div
      className="op-app"
      data-testid="operator-workspace"
      data-surface="operator"
      data-record={recordOpen ? 'open' : 'closed'}
      style={scanBrandStyle(props.branding)}
    >
      <TopBar
        session={session}
        chip={chip}
        counts={counts}
        logoUrl={props.logoUrl}
        modeLabel={props.modeLabel}
        chips={props.chips}
        testing={props.testing}
        menu={props.menu}
        onStaff={props.onTitle}
      />
      <div className="op-body">
        <div className="op-list-pane">
          <CommandField
            value={op.lookup.q}
            onChange={op.setQuery}
            readiness={readiness}
            allowPeople={op.allowPeople}
            searching={isSearching}
            activeId={activeResult}
          />
          <ViewTabs
            views={OPERATOR_VIEWS}
            view={view}
            counts={{ problems: op.problems.open.length }}
            onChange={op.changeView}
          />
          <div
            role="tabpanel"
            id={panelId}
            aria-labelledby={isSearching ? undefined : tabId(view)}
            aria-label={isSearching ? 'Search results' : undefined}
            className="op-panel"
            data-results={isSearching ? RESULT_LIST_ID : undefined}
          >
            {list}
          </div>
        </div>
        <main
          className="op-record-pane"
          data-operator-record
          aria-label={OPERATOR_COPY.landmark.record}
        >
          {recordOpen ? (
            <>
              <button type="button" className="op-back" onClick={op.close}>
                <ArrowLeft aria-hidden /> Back
              </button>
              <button
                type="button"
                className="op-close"
                onClick={op.close}
                aria-keyshortcuts="Escape"
              >
                Close <Kbd>Esc</Kbd>
              </button>
            </>
          ) : null}
          {record}
        </main>
      </div>
      <StatusBar online={state.online} syncedAt={op.activity.syncedAt} place="" hints={hints} />
      <HelpSheet
        open={ui.help}
        onOpenChange={(open) => op.send({ t: 'help', open })}
        rows={shortcuts}
      />
      <LiveAnnouncer message={polite} />
      {op.actions.sheet}
    </div>
  );
}
