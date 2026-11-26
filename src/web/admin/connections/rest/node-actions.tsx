import type { Ref } from 'react';
import { Button } from '../../../ui/index.ts';
import type { NodeAction } from './explorer-actions.ts';
import { PathCrumbs } from './path-crumbs.tsx';
import type { TreeRow } from './tree-model.ts';

/** The selected node: where it is, what it holds and what it can be used as. */
export function NodeActions({
  row,
  records,
  actions,
  onAction,
  firstRef,
}: {
  row: TreeRow | undefined;
  records: string;
  actions: readonly NodeAction[];
  onAction: (a: NodeAction) => void;
  firstRef: Ref<HTMLButtonElement>;
}) {
  if (!row) {
    return <p className="text-sm text-fg-muted">Click a value in the response.</p>;
  }
  const scalar = row.kind !== 'object' && row.kind !== 'array';
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <PathCrumbs pointer={row.pointer} records={records} />
      {scalar ? (
        <p className="min-w-0 break-words text-sm text-fg">
          <span className="text-fg-muted">Value </span>
          <span className="font-mono text-xs">{row.preview}</span>
        </p>
      ) : (
        <p className="text-sm text-fg-muted">
          {row.kind === 'array' ? `${row.total ?? row.count} items` : `${row.count} fields`}
        </p>
      )}
      {actions.length > 0 ? (
        <fieldset className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0">
          <legend className="sr-only">Use as</legend>
          {actions.map((a, i) => (
            <Button
              key={a.id}
              ref={i === 0 ? firstRef : undefined}
              variant="outline"
              size="sm"
              onClick={() => onAction(a)}
            >
              {a.label}
            </Button>
          ))}
        </fieldset>
      ) : (
        <p className="text-sm text-fg-muted">
          {row.kind === 'array' ? 'Not a list of records.' : 'Pick a value inside a record.'}
        </p>
      )}
    </div>
  );
}
