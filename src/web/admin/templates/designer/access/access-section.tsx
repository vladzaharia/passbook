import {
  ArrowDown,
  ArrowUp,
  Clock,
  Infinity as InfinityIcon,
  Plus,
  Ticket,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AccessPlan } from '@/passkit/types.ts';
import { removeWithTransition } from '../../../../lib/motion.ts';
import { Badge, Button, IconButton, SwitchRow, toast } from '../../../../ui/index.ts';
import { useDesigner } from '../context.tsx';
import './access.css';
import { accessLocalIssues, forPlan } from './issues.ts';
import { KIND_LABEL, MAX_PLANS, newLabel, planId, planSummary, readAccess } from './model.ts';
import { PlanInspector } from './plan-inspector.tsx';
import { Rules } from './rules.tsx';
import { ScannerStrip } from './scanner-strip.tsx';

const KIND_ICON = { always: InfinityIcon, timed: Clock, guest: Ticket } as const;

function KindPill({ kind }: { kind: AccessPlan['kind'] }) {
  const Icon = KIND_ICON[kind];
  return (
    <Badge tone={kind === 'guest' ? 'info' : kind === 'timed' ? 'warning' : 'accent'}>
      <Icon aria-hidden />
      {KIND_LABEL[kind]}
    </Badge>
  );
}

/** Plans, their rules and how the card looks at the door; off until the template is an access card. */
export function AccessSection() {
  const { doc, edit, select, state, dispatch } = useDesigner();
  const access = readAccess(doc);
  const issues = useMemo(() => accessLocalIssues(doc), [doc]);
  const [fresh, setFresh] = useState<string | null>(null);
  if (!access)
    return (
      <div className="grid gap-3">
        <SwitchRow
          label="Use as an access card"
          checked={false}
          onCheckedChange={(on) => on && edit({ op: 'access-enable' })}
        />
      </div>
    );
  const open = state.select.section === 'access' ? state.select.key : undefined;
  const plans = access.plans;
  const shown = plans.find((p) => p.id === open) ?? plans[0];
  const remove = (plan: AccessPlan) =>
    removeWithTransition(() => {
      edit({ op: 'access-plan-remove', id: plan.id });
      toast.undo(`${plan.label} removed`, () => dispatch({ type: 'undo' }));
    });
  return (
    <div className="grid gap-5">
      <SwitchRow
        label="Use as an access card"
        checked
        onCheckedChange={(on) => {
          if (on) return;
          edit({ op: 'access-disable' });
          toast.undo('Access removed', () => dispatch({ type: 'undo' }));
        }}
      />
      <section aria-label="Plans" className="grid gap-3">
        <ul aria-label="Plans" className="grid gap-1.5">
          {plans.map((plan, i) => {
            const mine = forPlan(issues, i).filter((x) => x.code !== 'ACCESS_HOURS_OVERLAP');
            const errors = forPlan(issues, i).filter((x) => x.severity === 'error').length;
            return (
              <li
                key={plan.id}
                className="dz-row"
                data-row-id={`plan:${plan.id}`}
                data-open={open === plan.id || undefined}
                data-new={fresh === plan.id || undefined}
              >
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    className="dz-pick"
                    data-target={`access:${plan.id}`}
                    aria-expanded={open === plan.id}
                    onClick={() =>
                      select({ section: 'access', key: open === plan.id ? undefined : plan.id })
                    }
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium text-fg-strong">{plan.label}</span>
                      <KindPill kind={plan.kind} />
                      {errors > 0 ? (
                        <Badge tone="danger">
                          {errors} {errors === 1 ? 'issue' : 'issues'}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="truncate text-xs text-fg-muted">{planSummary(plan)}</span>
                  </button>
                  <IconButton
                    label={`Move ${plan.label} up`}
                    icon={<ArrowUp aria-hidden />}
                    size="sm"
                    disabled={i === 0}
                    onClick={() => edit({ op: 'access-plan-move', id: plan.id, to: i - 1 })}
                  />
                  <IconButton
                    label={`Move ${plan.label} down`}
                    icon={<ArrowDown aria-hidden />}
                    size="sm"
                    disabled={i === plans.length - 1}
                    onClick={() => edit({ op: 'access-plan-move', id: plan.id, to: i + 1 })}
                  />
                  <IconButton
                    label={`Remove ${plan.label}`}
                    icon={<Trash2 aria-hidden />}
                    size="sm"
                    disabled={plans.length === 1}
                    onClick={() => remove(plan)}
                  />
                </div>
                {open === plan.id ? (
                  <>
                    {mine.length > 0 ? (
                      <ul aria-label={`${plan.label} issues`} className="grid gap-1 px-2 pt-2">
                        {mine.map((x) => (
                          <li
                            key={`${x.code}:${x.path}`}
                            role={x.severity === 'error' ? 'alert' : 'status'}
                            className={
                              x.severity === 'error'
                                ? 'text-xs text-danger'
                                : 'text-xs text-warning'
                            }
                          >
                            {x.message}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <PlanInspector plan={plan} issues={forPlan(issues, i)} />
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
        <Button
          variant="outline"
          size="sm"
          className="justify-self-start"
          iconStart={<Plus aria-hidden />}
          disabled={plans.length >= MAX_PLANS}
          onClick={() => {
            const id = planId(
              newLabel(plans),
              plans.map((p) => p.id),
            );
            edit({ op: 'access-plan-add' });
            setFresh(id);
            select({ section: 'access', key: id });
          }}
        >
          Add plan
        </Button>
        {plans.length >= MAX_PLANS ? (
          <p className="text-xs text-fg-muted">At most {MAX_PLANS} plans.</p>
        ) : null}
      </section>
      <section aria-label="Rules" className="grid gap-3 border-t border-border pt-4">
        <h3 className="text-xs font-medium uppercase tracking-wide text-fg-muted">Rules</h3>
        <Rules access={access} issues={issues} />
      </section>
      {shown ? <ScannerStrip plan={shown} /> : null}
    </div>
  );
}
