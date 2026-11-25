import { Siren } from 'lucide-react';
import { Button } from '../../../ui/button.tsx';
import { ACCESS_COPY } from '../../ui/copy-access.ts';
import type { RollControls } from '../floor/roll-call-dialogs.tsx';
import type { Floor } from '../floor/use-floor.ts';
import { ActivityView } from '../lists/activity-view.tsx';
import { InsideView } from '../lists/inside-view.tsx';
import { ProblemsView } from '../lists/problems-view.tsx';
import { RollCallView } from '../lists/roll-call-view.tsx';
import { SearchResults } from '../lists/search-results.tsx';
import { searching } from '../operator-model.ts';
import type { useOperator } from '../use-operator.ts';

/** The one list the pane shows: search results, a roll call, or the view picked in the tabs. */
export function ListBody({
  op,
  floor,
  controls,
  wide,
  tracks,
  online,
  timeZone,
}: {
  op: ReturnType<typeof useOperator>;
  floor: Floor;
  controls: RollControls;
  wide: boolean;
  tracks: boolean;
  online: boolean;
  timeZone: string | undefined;
}) {
  const { ui } = op;
  const view = ui.view;
  const call = floor.roll.call;
  const isSearching = searching(ui);
  const hint =
    isSearching && op.lookup.result === null
      ? op.lookup.busy
        ? 'Searching'
        : 'Type 3 letters'
      : null;
  const selectedPassId = op.record?.kind === 'pass' ? op.record.passId : null;
  return isSearching ? (
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
  ) : call ? (
    <RollCallView
      roll={floor.roll}
      call={call}
      online={online}
      now={op.clock}
      selectedPassId={selectedPassId}
      timeZone={timeZone}
      onOpen={(p) => op.open(p.passId, 'roll-call')}
      onPrint={wide ? undefined : () => controls.setPrinting(true)}
      onEnd={wide ? undefined : () => controls.setConfirm('end')}
    />
  ) : view === 'inside' && tracks ? (
    <InsideView
      inside={floor.inside}
      online={online}
      now={op.clock}
      selectedPassId={selectedPassId}
      timeZone={timeZone}
      onOpen={(row) => op.open(row.passId, 'inside')}
      footer={
        <footer className="op-rc-foot">
          <Button
            variant="danger"
            iconStart={<Siren aria-hidden />}
            disabled={!online || floor.roll.busy}
            onClick={() => controls.setConfirm('start')}
          >
            {ACCESS_COPY.roll.start}
          </Button>
        </footer>
      }
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
}
