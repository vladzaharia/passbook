import { Link } from '@tanstack/react-router';
import { Check, ChevronRight, Mail, Plus } from 'lucide-react';
import { type CSSProperties, type ReactNode, useCallback, useState } from 'react';
import type { MetricsOverview } from '@/shared/contracts/metrics.ts';
import { cn } from '@/web/lib/cn.ts';
import { useChangeCount } from '@/web/lib/motion.ts';
import { type ArtName, Button, Card, CardBody, Checklist, EntityArt } from '@/web/ui/index.ts';

const KEY = 'wallet-get-started-dismissed';

function readDismissed(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    // Storage blocked: the checklist shows until the steps are done.
    return false;
  }
}

/** Per viewer: once dismissed, this browser shows the charts instead. */
export function useGetStartedDismissed(): [boolean, () => void] {
  const [dismissed, setDismissed] = useState(readDismissed);
  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      // See readDismissed; it stays dismissed for this page.
    }
  }, []);
  return [dismissed, dismiss];
}

/** Done once a pass is in a Wallet: every step before it has to be done by then. */
export const setupDone = (setup: MetricsOverview['setup']) => setup.walletPasses > 0;

interface Step {
  id: string;
  label: string;
  done: boolean;
  to: string;
  search?: Record<string, string>;
  verb: string;
  /** Create verbs lead with their icon; navigation trails a chevron. */
  iconStart?: ReactNode;
  iconEnd?: ReactNode;
  art: ArtName;
}

/** The one first-run path, for the overview and for an organization. */
function firstRunSteps(setup: MetricsOverview['setup'], orgId?: string): Step[] {
  const scope = orgId ? { orgId } : undefined;
  return [
    {
      id: 'blueprint',
      label: 'Use a blueprint',
      done: setup.assignedTemplates > 0,
      to: '/admin/templates',
      search: scope,
      verb: 'Blueprints',
      iconEnd: <ChevronRight aria-hidden />,
      art: 'template',
    },
    {
      id: 'approve',
      label: 'Approve it',
      done: setup.approvedTemplates > 0,
      to: '/admin/templates',
      search: scope,
      verb: 'Review',
      iconEnd: <ChevronRight aria-hidden />,
      art: 'building',
    },
    {
      id: 'pass',
      label: 'Issue a pass',
      done: setup.passes > 0,
      to: '/admin/passes/new',
      search: scope,
      verb: 'New pass',
      iconStart: <Plus aria-hidden />,
      art: 'passes',
    },
    {
      id: 'phone',
      label: 'Add it to your phone',
      done: setupDone(setup),
      to: setup.latestPassId ? `/admin/passes/${setup.latestPassId}` : '/admin/passes',
      search: setup.latestPassId ? { tab: 'holder' } : scope,
      verb: 'Send email',
      iconStart: <Mail aria-hidden />,
      art: 'passes',
    },
  ];
}

/** Steps for a `Checklist`: the first open one is the primary action. */
export function checklistSteps(setup: MetricsOverview['setup'], orgId?: string) {
  const steps = firstRunSteps(setup, orgId);
  const next = steps.findIndex((s) => !s.done);
  return steps.map((s, i) => ({
    id: s.id,
    label: s.label,
    done: s.done,
    action:
      next >= 0 && i > next && !s.done ? (
        <Button size="sm" variant="outline" disabled>
          Needs step {next + 1}
        </Button>
      ) : (
        <Button
          asChild
          size="sm"
          variant={i === next ? 'primary' : 'outline'}
          iconStart={s.iconStart}
          iconEnd={s.iconEnd}
        >
          <Link to={s.to} search={s.search}>
            {s.verb}
          </Link>
        </Button>
      ),
  }));
}

/**
 * One active art per screen: only the current step's art enters and beats. Done steps hold their
 * final frame with a check; later steps wait dimmed. A step that becomes current after mount
 * enters 120 ms after the previous step's check pops.
 */
function StepArt({ name, state }: { name: ArtName; state: 'done' | 'next' | 'later' }) {
  const moved = useChangeCount(state);
  const checked = useChangeCount(state === 'done');
  return (
    <li
      data-state={state}
      style={moved > 0 ? ({ '--wl-art-delay': '120ms' } as CSSProperties) : undefined}
      className={cn(
        'relative grid place-items-center rounded-lg border p-1.5 transition-opacity duration-(--wl-dur-hover)',
        state === 'next' ? 'border-accent bg-accent-subtle' : 'border-border bg-surface-sunken',
        state === 'later' && 'opacity-45',
      )}
    >
      <EntityArt name={name} size="sm" still={state !== 'next'} />
      {state === 'done' ? (
        <span
          aria-hidden
          className="absolute -right-1.5 -bottom-1.5 grid size-5 place-items-center rounded-full bg-accent text-accent-on shadow-elevation-1"
        >
          <Check key={checked} className={cn('size-3', checked > 0 && 'wl-check')} />
        </span>
      ) : null}
    </li>
  );
}

/** "Get started": four steps that check themselves from server counts. */
export function GetStarted({
  setup,
  organization,
  onDismiss,
}: {
  setup: MetricsOverview['setup'];
  organization?: string | undefined;
  onDismiss: () => void;
}) {
  const steps = firstRunSteps(setup);
  const next = steps.findIndex((s) => !s.done);
  return (
    <Card>
      <CardBody>
        {organization ? (
          <p className="mb-3 text-xs text-fg-muted">Live passes and emails for {organization}</p>
        ) : null}
        <Checklist
          title="Get started"
          onDismiss={onDismiss}
          aside={
            <ol aria-hidden className="flex items-center gap-3 max-sm:hidden">
              {steps.map((s, i) => (
                <StepArt
                  key={s.id}
                  name={s.art}
                  state={s.done ? 'done' : i === next ? 'next' : 'later'}
                />
              ))}
            </ol>
          }
          steps={checklistSteps(setup)}
        />
      </CardBody>
    </Card>
  );
}
