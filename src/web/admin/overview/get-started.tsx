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

/** Done once a pass email went out: every step before it has to be done by then. */
export const setupDone = (setup: MetricsOverview['setup']) => setup.passEmailsSent > 0;

interface Step {
  id: string;
  label: string;
  done: boolean;
  to: string;
  search?: Record<string, string>;
  verb: string;
  icon: ReactNode;
  art?: ArtName;
}

function StepArt({
  name,
  state,
  index,
}: {
  name: ArtName;
  state: 'done' | 'next' | 'later';
  index: number;
}) {
  const changed = useChangeCount(state === 'done');
  return (
    <li
      data-state={state}
      // The three pictures play in turn: building, template, passes (80 / 200 / 320 ms).
      style={{ '--wl-art-delay': `${80 + index * 120}ms` } as CSSProperties}
      className={cn(
        'relative grid place-items-center rounded-lg border p-2 transition-opacity duration-(--wl-dur-hover)',
        state === 'next' ? 'border-accent bg-accent-subtle' : 'border-border bg-surface-sunken',
        state === 'later' && 'opacity-50',
      )}
    >
      <EntityArt name={name} size="sm" />
      {state === 'done' ? (
        <span
          aria-hidden
          className="absolute -top-2 -right-2 grid size-5 place-items-center rounded-full bg-accent text-accent-on shadow-elevation-1"
        >
          <Check key={changed} className={cn('size-3', changed > 0 && 'wl-check')} />
        </span>
      ) : null}
    </li>
  );
}

/** "Get started": four steps that check themselves from server counts. */
export function GetStarted({
  setup,
  onDismiss,
}: {
  setup: MetricsOverview['setup'];
  onDismiss: () => void;
}) {
  const steps: Step[] = [
    {
      id: 'org',
      label: 'Create an organization',
      done: setup.orgs > 0,
      to: '/admin/orgs',
      verb: 'New organization',
      icon: <Plus aria-hidden />,
      art: 'building',
    },
    {
      id: 'template',
      label: 'Choose a template',
      done: setup.assignedTemplates > 0,
      to: '/admin/templates',
      verb: 'Templates',
      icon: <ChevronRight aria-hidden />,
      art: 'template',
    },
    {
      id: 'pass',
      label: 'Issue your first pass',
      done: setup.passes > 0,
      to: '/admin/passes/new',
      verb: 'New pass',
      icon: <Plus aria-hidden />,
      art: 'passes',
    },
    {
      id: 'send',
      label: 'Send it to a holder',
      done: setupDone(setup),
      to: setup.latestPassId ? `/admin/passes/${setup.latestPassId}` : '/admin/passes',
      search: setup.latestPassId ? { tab: 'holder' } : undefined,
      verb: 'Send email',
      icon: <Mail aria-hidden />,
    },
  ];
  const next = steps.findIndex((s) => !s.done);
  const trailing = (s: Step, i: number) => (
    <Button
      asChild
      size="sm"
      variant={i === next ? 'primary' : 'outline'}
      iconStart={s.verb === 'Templates' ? undefined : s.icon}
      iconEnd={s.verb === 'Templates' ? s.icon : undefined}
    >
      <Link to={s.to as never} search={s.search as never}>
        {s.verb}
      </Link>
    </Button>
  );
  return (
    <Card>
      <CardBody className="grid items-center gap-6 md:grid-cols-[minmax(0,1fr)_auto] md:gap-10">
        <Checklist
          title="Get started"
          onDismiss={onDismiss}
          steps={steps.map((s, i) => ({
            id: s.id,
            label: s.label,
            done: s.done,
            action: trailing(s, i),
          }))}
        />
        <ol aria-hidden className="flex items-center justify-center gap-3 max-md:order-first">
          {steps.flatMap((s, i) =>
            s.art ? (
              <StepArt
                key={s.id}
                name={s.art}
                index={i}
                state={s.done ? 'done' : i === next ? 'next' : 'later'}
              />
            ) : (
              []
            ),
          )}
        </ol>
      </CardBody>
    </Card>
  );
}
