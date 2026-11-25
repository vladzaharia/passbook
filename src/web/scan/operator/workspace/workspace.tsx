import { ArrowLeft } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import type { ScanCounts } from '../../../../shared/contracts/scan.ts';
import type { ScanBranding, ScanSession } from '../../../../shared/contracts/scan-session.ts';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { useMediaQuery } from '../../../lib/media.ts';
import { Toaster } from '../../../ui/toaster.tsx';
import type { ScanApi } from '../../api/scan-api.ts';
import { useScanMachine } from '../../machine/use-scan-machine.ts';
import type { ScanRuntime } from '../../platform/runtime.ts';
import { scanBrandStyle } from '../../platform/scan-branding.tsx';
import { deskOf, resultOf } from '../../result/desk.ts';
import type { Announcement } from '../../ui/live-announcer.tsx';
import { LiveAnnouncer } from '../../ui/live-announcer.tsx';
import { isDeskRole, trackedPlace } from '../../ui/place.ts';
import { sessionTime } from '../../ui/session-time.ts';
import { Floor } from '../floor/floor.tsx';
import { nextToConfirm, rollOrder, viewsFor } from '../floor/floor-model.ts';
import { RollCallStrip } from '../floor/roll-call-cards.tsx';
import { RollCallDialogs, useRollControls } from '../floor/roll-call-dialogs.tsx';
import { useFloor } from '../floor/use-floor.ts';
import { useHub } from '../floor/use-hub.ts';
import { useRollMarks } from '../floor/use-roll-marks.ts';
import { RESULT_LIST_ID, resultId } from '../lists/search-results.tsx';
import { searching } from '../operator-model.ts';
import { passIdOf, RecordPass, RecordScan } from '../record/record.tsx';
import { RecordPreview } from '../record/record-preview.tsx';
import { useOperator } from '../use-operator.ts';
import { CommandField, Kbd, type Readiness } from './command-field.tsx';
import { HelpSheet, shortcutsFor } from './help-sheet.tsx';
import { hintsOf } from './hints.ts';
import { IdleView } from './idle-view.tsx';
import { ListBody } from './list-body.tsx';
import { recordContext } from './record-context.ts';
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
  /** When this shift began: the floor's totals start here. */
  shiftStart?: number;
  /** Open the hub connection. Off in the gallery and in tests, which have no hub. */
  live?: boolean;
}

/**
 * The operator's console: a field and a list on the left, the person on the right. Under it the
 * scan machine runs as ever; a scan opens its record without taking the focus from the operator.
 */
export function OperatorWorkspace(props: WorkspaceProps) {
  const { api, runtime, session, counts } = props;
  const desk = isDeskRole(session);
  const tracks = desk && trackedPlace(counts, session.event) !== null;
  const views = useMemo(() => viewsFor({ tracks, desk }), [tracks, desk]);
  const hub = useHub(props.live ?? true);
  const op = useOperator({
    api,
    runtime,
    session,
    views,
    poll: { kick: hub.pulses, hubUp: hub.up },
  });
  const { dispatch: machine, now, view: scanView } = useScanMachine();
  const { state, ui, results } = op;
  const view = ui.view;
  const wide = useMediaQuery('(min-width: 1280px)');
  const [opened] = useState(Date.now);
  const shiftStart = props.shiftStart ?? opened;
  const floor = useFloor({
    api,
    runtime,
    session,
    online: state.online,
    hub,
    tracks,
    wide,
    view,
    shiftStart,
    onBlocked: (info) => machine({ type: 'fail', key: '', ...info }),
  });
  const controls = useRollControls();
  const call = floor.roll.call;
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
  const hints = hintsOf({
    searching: isSearching,
    record: recordOpen,
    undoable: op.undoable,
    views: views.length,
    rollCall: call !== null,
  });
  const shortcuts = shortcutsFor({
    record: recordOpen,
    rollCall: call !== null,
    views: views.length,
    walkIn: false,
  });
  // A visitor's check-in is the ordinary scan of their pass: its card opens as the record.
  const checkIn = (v: { passId: string }) => {
    machine({ type: 'dismiss' });
    runtime.emit({ method: 'manual', passId: v.passId });
  };
  const { person, mark } = useRollMarks(op, floor);
  const list = (
    <ListBody
      op={op}
      floor={floor}
      controls={controls}
      wide={wide}
      tracks={tracks}
      desk={desk}
      online={state.online}
      timeZone={timeZone}
      checkIn={checkIn}
    />
  );
  const result = resultOf(state.loop, counts);
  const ctx = recordContext({
    op,
    props,
    timeZone,
    clock: now,
    machine,
    buddy: result ? scanView.buddy : null,
    result,
  });
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
      <p className="op-checking" role="status">
        Checking
      </p>
    )
  ) : op.record?.kind === 'pass' && op.record.from === 'preview' ? (
    op.previewRow ? (
      <RecordPreview row={op.previewRow} timeZone={timeZone} />
    ) : null
  ) : op.record?.kind === 'pass' ? (
    <>
      {person ? (
        <RollCallStrip
          person={person}
          place={person.placeName}
          seen={sessionTime(person.since, timeZone)}
          onMark={(status) => mark(person.passId, status)}
          onNext={() => {
            const next = call ? nextToConfirm(rollOrder(call), person.passId) : null;
            if (next) op.open(next, 'roll-call');
          }}
        />
      ) : null}
      <RecordPass key={op.record.passId} ctx={ctx} record={op.record} />
    </>
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
        rollCall={
          call ? { done: call.counts.present + call.counts.out, total: call.counts.total } : null
        }
      />
      <div className="op-body" data-floor>
        <section className="op-list-pane" aria-label={OPERATOR_COPY.landmark.lists}>
          <CommandField
            value={op.lookup.q}
            onChange={op.setQuery}
            readiness={readiness}
            allowPeople={op.allowPeople}
            searching={isSearching}
            activeId={activeResult}
          />
          {call ? null : (
            <ViewTabs
              views={views}
              view={view}
              counts={{
                problems: op.problems.open.length,
                inside: inNowOf(counts)?.count ?? 0,
                visitors: floor.visitors.items?.length ?? 0,
              }}
              onChange={op.changeView}
            />
          )}
          <div
            role="tabpanel"
            id={panelId}
            aria-labelledby={isSearching || call ? undefined : tabId(view)}
            aria-label={
              isSearching ? 'Search results' : call ? OPERATOR_COPY.views.rollTitle : undefined
            }
            className="op-panel"
            data-results={isSearching ? RESULT_LIST_ID : undefined}
          >
            {list}
          </div>
        </section>
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
        <Floor
          floor={floor}
          online={state.online}
          counts={counts}
          shiftStart={shiftStart}
          now={op.clock}
          timeZone={timeZone}
          controls={controls}
          onCheckIn={checkIn}
          onOpenVisitor={(v) => op.open(v.passId, 'visitors')}
        />
      </div>
      <StatusBar online={state.online} syncedAt={op.activity.syncedAt} place="" hints={hints} />
      <HelpSheet
        open={ui.help}
        onOpenChange={(open) => op.send({ t: 'help', open })}
        rows={shortcuts}
      />
      <LiveAnnouncer message={polite} />
      {op.actions.sheet}
      <Toaster />
      <RollCallDialogs
        roll={floor.roll}
        controls={controls}
        place={floor.inside.state.places.map((p) => p.name).join(', ')}
      />
    </div>
  );
}
