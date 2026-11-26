import { TriangleAlert } from 'lucide-react';
import { CONSOLE_COPY } from '../../../../shared/copy/developers-bench-console.ts';
import { MethodPill } from '../../../developers/ui/method-pill.tsx';
import { BenchList } from '../../bench/list.tsx';
import type { BenchSelection } from '../../bench/use-selection.ts';
import type { RunIndexItem } from '../types.ts';
import { LazyState } from './lazy-state.tsx';

/** An operation in the index with the group it is listed under. */
export interface IndexOp extends RunIndexItem {
  group: string;
}

export const idOfOp = (op: IndexOp): string => op.id;
const groupOfOp = (op: IndexOp): string => op.group;

/**
 * Every runnable operation by group: the Workbench's one list, with the method first and a caution
 * on the ones that change data. The pane beside the stage from 1180 px, the "Operation" sheet below.
 */
export function OpIndex({
  items,
  selection,
  query,
  onClear,
}: {
  items: readonly IndexOp[];
  /** What the search holds: the empty state names it. */
  query: string;
  selection: BenchSelection<IndexOp>;
  onClear: () => void;
}) {
  return (
    <div className="console-idx">
      <BenchList
        label={CONSOLE_COPY.index}
        items={items}
        idOf={idOfOp}
        groupOf={groupOfOp}
        selection={selection}
        row={(op) => ({
          lead: <MethodPill method={op.method} />,
          title: op.title,
          trail: op.destructive ? (
            <TriangleAlert
              className="console-caution"
              role="img"
              aria-label={CONSOLE_COPY.caution}
            />
          ) : undefined,
        })}
        empty={
          <LazyState
            scene="no-match"
            heading="p"
            {...(query.trim() ? { title: CONSOLE_COPY.noMatch(query.trim()) } : {})}
          >
            <button type="button" className="btn outline" onClick={onClear}>
              {CONSOLE_COPY.clear}
            </button>
          </LazyState>
        }
      />
    </div>
  );
}
