import type { MachineEvent } from '../../machine/access-events.ts';
import type { ScanOutcome } from '../../machine/types.ts';
import type { RecordContext } from '../record/record.tsx';
import type { useOperator } from '../use-operator.ts';
import { focusSearch } from './focus.ts';
import type { WorkspaceProps } from './workspace.tsx';

/** What a record needs from the console around it: the scanner, the clock, and how to open, close and look up. */
export function recordContext({
  op,
  props,
  timeZone,
  clock,
  machine,
  buddy,
  result,
}: {
  op: ReturnType<typeof useOperator>;
  props: WorkspaceProps;
  timeZone: string | undefined;
  clock: number;
  machine: (event: MachineEvent) => void;
  buddy: RecordContext['buddy'];
  result: ScanOutcome | null;
}): RecordContext {
  const { api, runtime, session } = props;
  return {
    api,
    runtime,
    session,
    timeZone,
    clock,
    keys: op.recordKeys,
    machine,
    release: () => op.send({ t: 'close' }),
    type: (text) => {
      focusSearch(false);
      op.setQuery(op.ui.query + text);
    },
    buddy,
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
      op.undoable && result?.scanId && result.scanId === op.state.recent[0]?.scanId
        ? () => op.undo(result.scanId ?? '')
        : null,
  };
}
