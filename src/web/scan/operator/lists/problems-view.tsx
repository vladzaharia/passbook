import { Check, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { Button } from '../../../ui/button.tsx';
import { sessionTime } from '../../ui/session-time.ts';
import { type ActivityItem, viewOf } from './activity-model.ts';
import { PersonAvatar } from './person-avatar.tsx';
import type { Problem, ResolvedProblem } from './problems-model.ts';
import { useRoving } from './use-roving.ts';
import './lists.css';

const C = OPERATOR_COPY.problems;
const fill = (text: string, n: number) => text.replace('{n}', String(n));

function ProblemRow({
  item,
  index,
  roving,
  selected,
  timeZone,
  action,
  onOpen,
}: {
  item: ActivityItem;
  index: number;
  roving: ReturnType<typeof useRoving>;
  selected: boolean;
  timeZone?: string | undefined;
  action?: ReactNode;
  onOpen: (item: ActivityItem) => void;
}) {
  const row = viewOf(item);
  return (
    <li
      className="op-row"
      data-row-key={item.id}
      data-selected={selected || undefined}
      data-tone={row.tone}
    >
      <button
        type="button"
        className="op-row-main"
        data-roving
        data-testid="op-problem-row"
        tabIndex={roving.tabIndexOf(index)}
        aria-disabled={row.passId === null || undefined}
        onFocus={() => roving.onFocusRow(index)}
        onClick={() => row.passId && onOpen(item)}
      >
        <PersonAvatar name={row.name} tone={row.tone} unknown={row.unknown} />
        <span className="op-row-text">
          <span className="op-row-title" title={row.name}>
            {row.name}
          </span>
          <span className="op-row-meta">
            <em data-tone={row.tone}>{row.verdict}</em> · {row.where}
          </span>
        </span>
        <time className="op-row-time" dateTime={new Date(row.at).toISOString()}>
          {sessionTime(row.at, timeZone)}
        </time>
      </button>
      {action ? <span className="op-row-action">{action}</span> : null}
    </li>
  );
}

/** Refusals and holds someone can still act on, then what was settled today. */
export function ProblemsView({
  open,
  resolved,
  selectedPassId,
  timeZone,
  onOpen,
  onLetIn,
  onSeen,
}: {
  open: readonly Problem[];
  resolved: readonly ResolvedProblem[];
  selectedPassId: string | null;
  timeZone?: string | undefined;
  onOpen: (item: ActivityItem) => void;
  onLetIn: (item: ActivityItem) => void;
  onSeen: (id: string) => void;
}) {
  const roving = useRoving();
  return (
    <section className="op-list" aria-label={OPERATOR_COPY.tabs.problems}>
      <div className="op-list-scroll">
        <div className="op-list-head">
          <span>{fill(C.needs, open.length)}</span>
          <span>{C.last}</span>
        </div>
        {!open.length ? <p className="op-list-note">{C.empty}</p> : null}
        <ul className="op-rows" onKeyDown={roving.onKeyDown}>
          {open.map(({ item, canLetIn }, index) => (
            <ProblemRow
              key={item.id}
              item={item}
              index={index}
              roving={roving}
              timeZone={timeZone}
              selected={selectedPassId !== null && item.passId === selectedPassId}
              onOpen={onOpen}
              action={
                canLetIn ? (
                  <Button
                    size="sm"
                    variant="outline"
                    iconStart={<ShieldCheck aria-hidden />}
                    onClick={() => onLetIn(item)}
                  >
                    {C.letIn}
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => onSeen(item.id)}>
                    {C.seen}
                  </Button>
                )
              }
            />
          ))}
        </ul>
        {resolved.length ? (
          <>
            <div className="op-list-head">
              <span>{fill(C.resolved, resolved.length)}</span>
            </div>
            <ul className="op-rows" data-dim>
              {resolved.map(({ item, by, how }, index) => (
                <ProblemRow
                  key={item.id}
                  item={item}
                  index={open.length + index}
                  roving={roving}
                  timeZone={timeZone}
                  selected={false}
                  onOpen={onOpen}
                  action={
                    <span className="op-resolved">
                      <Check aria-hidden />
                      {how === 'let_in' ? 'Let in' : C.seen}
                      {by ? ` · ${by}` : ''}
                    </span>
                  }
                />
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </section>
  );
}
