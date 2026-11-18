import {
  ArrowDown,
  ArrowUp,
  LogIn,
  type LucideIcon,
  Minus,
  PenLine,
  Plus,
  Ticket,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ScanActionKind } from '@/passkit/types.ts';
import { removeWithTransition } from '../../../../../lib/motion.ts';
import { Badge, Button, IconButton, toast } from '../../../../../ui/index.ts';
import { useDesigner } from '../../context.tsx';
import { ActionEditor } from './action-editor.tsx';
import { IssueList } from './fields.tsx';
import { FlagFields } from './flag-fields.tsx';
import { actionLocalIssues, forAction, forList, forPart } from './issues.ts';
import {
  actionSummary,
  KINDS,
  kindLabel,
  MAX_ACTIONS,
  newAction,
  readActions,
  resolvedActions,
  scanBlock,
} from './model.ts';
import { WindowFields } from './window-fields.tsx';
import './actions.css';

const ICON: Record<ScanActionKind, LucideIcon> = {
  check_in: LogIn,
  add: Plus,
  take: Minus,
  set: PenLine,
  use_up: Ticket,
};

const H3 = 'text-xs font-medium uppercase tracking-wide text-fg-muted';

/** What staff can do with a pass at a scanner: the actions, when a pass is good, and notes. */
export function ActionsSection() {
  const { doc, edit, select, state, dispatch, focusTarget, readOnly } = useDesigner();
  const issues = useMemo(() => actionLocalIssues(doc), [doc]);
  const [fresh, setFresh] = useState<string | null>(null);
  if (!scanBlock(doc))
    return (
      <div className="grid gap-3">
        <p className="text-sm text-fg-muted">Staff can only look this pass up.</p>
        <Button
          variant="outline"
          size="sm"
          className="justify-self-start"
          iconStart={<Plus aria-hidden />}
          disabled={readOnly}
          onClick={() => edit({ op: 'scan-enable' })}
        >
          Add scan actions
        </Button>
      </div>
    );
  const actions = readActions(doc);
  const resolved = resolvedActions(doc);
  const open = state.select.section === 'scan-actions' ? state.select.key : undefined;
  const full = actions.length >= MAX_ACTIONS;
  const remove = (id: string, label: string) =>
    removeWithTransition(() => {
      edit({ op: 'scan-action-remove', id });
      toast.undo(`${label} removed`, () => dispatch({ type: 'undo' }));
    });
  return (
    <div className="grid gap-5">
      <section aria-label="Actions" className="grid gap-3">
        <ul aria-label="Actions" className="grid gap-1.5">
          {actions.map((a, i) => {
            const mine = forAction(issues, i);
            const errors = mine.filter((x) => x.severity === 'error').length;
            const r = resolved.get(a.id);
            const Icon = ICON[a.kind];
            return (
              <li
                key={a.id}
                className="dz-row"
                data-row-id={`scan-action:${a.id}`}
                data-open={open === a.id || undefined}
                data-new={fresh === a.id || undefined}
              >
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    className="dz-pick"
                    data-target={`scan-actions:${a.id}`}
                    aria-expanded={open === a.id}
                    onClick={() =>
                      select({ section: 'scan-actions', key: open === a.id ? undefined : a.id })
                    }
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Icon aria-hidden className="sa-kind size-4 shrink-0 text-accent" />
                      <span className="truncate font-medium text-fg-strong">{a.label}</span>
                      <Badge>{kindLabel(a.kind)}</Badge>
                      {errors > 0 ? (
                        <Badge tone="danger">
                          {errors} {errors === 1 ? 'issue' : 'issues'}
                        </Badge>
                      ) : null}
                    </span>
                    {r ? (
                      <span className="truncate text-xs text-fg-muted">{actionSummary(r)}</span>
                    ) : null}
                  </button>
                  <IconButton
                    label={`Move ${a.label} up`}
                    icon={<ArrowUp aria-hidden />}
                    size="sm"
                    disabled={i === 0 || readOnly}
                    onClick={() => edit({ op: 'scan-action-move', id: a.id, to: i - 1 })}
                  />
                  <IconButton
                    label={`Move ${a.label} down`}
                    icon={<ArrowDown aria-hidden />}
                    size="sm"
                    disabled={i === actions.length - 1 || readOnly}
                    onClick={() => edit({ op: 'scan-action-move', id: a.id, to: i + 1 })}
                  />
                  <IconButton
                    label={`Remove ${a.label}`}
                    icon={<Trash2 aria-hidden />}
                    size="sm"
                    disabled={actions.length === 1 || readOnly}
                    onClick={() => remove(a.id, a.label)}
                  />
                </div>
                {open === a.id && r ? <ActionEditor action={a} resolved={r} issues={mine} /> : null}
              </li>
            );
          })}
        </ul>
        <IssueList issues={forList(issues)} label="Action list issues" />
        <fieldset aria-label="Add an action" className="grid gap-2 border-0 p-0">
          <span className={H3}>{full ? `At most ${MAX_ACTIONS} actions` : 'Add an action'}</span>
          <div className="flex flex-wrap gap-1.5">
            {KINDS.map((k) => {
              const Icon = ICON[k.value];
              return (
                <Button
                  key={k.value}
                  variant="outline"
                  size="sm"
                  title={k.hint}
                  iconStart={<Icon aria-hidden />}
                  disabled={full || readOnly}
                  onClick={() => {
                    const id = newAction(doc, k.value).id;
                    edit({ op: 'scan-action-add', kind: k.value });
                    setFresh(id);
                    select({ section: 'scan-actions', key: id });
                  }}
                >
                  {k.label}
                </Button>
              );
            })}
          </div>
        </fieldset>
      </section>
      <section
        aria-label="Valid between"
        data-target="scan-actions:window"
        className="grid gap-3 border-t border-border pt-4"
      >
        <h3 className={H3}>Valid between</h3>
        <WindowFields issues={forPart(issues, 'window')} />
      </section>
      <section
        aria-label="Notes"
        data-target="scan-actions:flags"
        className="grid gap-3 border-t border-border pt-4"
      >
        <h3 className={H3}>Notes</h3>
        <FlagFields issues={forPart(issues, 'flags')} />
      </section>
      <section aria-label="Related" className="flex flex-wrap gap-2 border-t border-border pt-4">
        <Button variant="ghost" size="sm" onClick={() => select({ section: 'barcode' })}>
          Find by
        </Button>
        <Button variant="ghost" size="sm" onClick={() => select({ section: 'access' })}>
          Access
        </Button>
        <Button variant="ghost" size="sm" onClick={() => focusTarget({ section: 'scan-display' })}>
          Scan screen
        </Button>
      </section>
    </div>
  );
}
