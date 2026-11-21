import { Link } from '@tanstack/react-router';
import { ChevronRight, Link2, Plus, Upload, X } from 'lucide-react';
import { type ReactNode, useCallback, useState } from 'react';
import type { MetricsOverview } from '@/shared/contracts/metrics.ts';
import { cn } from '@/web/lib/cn.ts';
import { useChangeCount } from '@/web/lib/motion.ts';
import { Buddy, Button, IconButton, Skeleton, Tick } from '@/web/ui/index.ts';
import { useTemplate, useTemplates } from '../templates/api.ts';
import { nextAction } from '../templates/releases/next-action.ts';
import { currentStep, PATH_STEPS, type PathStep, stepDone } from './first-pass-state.ts';
import { FirstPassTiles } from './first-pass-tiles.tsx';
import './first-pass.css';

const KEY = 'wallet-first-pass-next-dismissed';

function readDismissed(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    // Storage blocked: the Next row shows until the page is left.
    return false;
  }
}

/** Per viewer: once closed, this browser shows the charts alone. */
export function useNextRowDismissed(): [boolean, () => void] {
  const [dismissed, setDismissed] = useState(readDismissed);
  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      // See readDismissed; it stays closed for this page.
    }
  }, []);
  return [dismissed, dismiss];
}

function Mark({ index, state }: { index: number; state: 'done' | 'now' | 'later' }) {
  const changed = useChangeCount(state === 'done');
  return (
    <span
      aria-hidden
      className={cn(
        'fp-mark inline-flex size-9 items-center justify-center rounded-full border text-sm font-semibold tabular-nums',
        state === 'done' && 'border-accent bg-accent text-accent-on',
        state === 'now' && 'border-accent bg-accent-subtle text-fg-strong',
        state === 'later' && 'border-border-strong bg-surface-raised text-fg-muted',
      )}
    >
      {state === 'done' ? <Tick key={changed} draw={changed > 0} className="size-4" /> : index + 1}
    </span>
  );
}

/** Three steps on one line: done ones check, the current one is ringed, later ones wait. */
function Track({ setup }: { setup: MetricsOverview['setup'] }) {
  const at = currentStep(setup);
  return (
    <ol className="fp-track m-0 grid list-none grid-cols-3 p-0">
      {PATH_STEPS.map((s, i) => {
        const state = stepDone(setup, s.id) ? 'done' : s.id === at ? 'now' : 'later';
        return (
          <li
            key={s.id}
            data-state={state}
            aria-current={state === 'now' ? 'step' : undefined}
            className="fp-step flex flex-col items-center gap-2 text-center"
          >
            <Mark index={i} state={state} />
            <span
              className={cn(
                'text-sm font-medium',
                state === 'later' ? 'text-fg-muted' : 'text-fg-strong',
              )}
            >
              {s.label}
              {state === 'done' ? <span className="sr-only"> (done)</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The org's newest own template: where the path goes once a blueprint is in. */
function useOwnTemplate(orgId: string, on: boolean) {
  const list = useTemplates({ orgId }, on);
  const own = (list.data?.items ?? [])
    .filter((t) => !t.blueprint && t.orgId === orgId && t.status === 'active')
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  return { own, pending: on && list.isPending };
}

function TemplateStep({ orgId }: { orgId: string }) {
  const { own, pending } = useOwnTemplate(orgId, true);
  const detail = useTemplate(own?.id, orgId);
  if (pending || (own && detail.isPending)) return <Skeleton className="mx-auto h-9 w-44" />;
  if (!own)
    return (
      <Button asChild variant="outline" iconEnd={<ChevronRight aria-hidden />}>
        <Link to="/admin/o/$orgId/templates" params={{ orgId }}>
          Templates
        </Link>
      </Button>
    );
  const draft = detail.data?.release?.draft?.version ?? '';
  const action = nextAction(detail.data?.release?.next, draft);
  return (
    <Button asChild iconEnd={<ChevronRight aria-hidden />}>
      <Link to="/admin/o/$orgId/templates/$templateId" params={{ orgId, templateId: own.id }}>
        {action.kind === 'pass' || action.kind === 'wait' ? 'Open template' : action.label}
      </Link>
    </Button>
  );
}

/** The seated buddy on a card edge. One per screen; decorative. */
function Seat({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section aria-label={label} className="fp-card relative mt-[4.5rem]">
      <div aria-hidden>
        <Buddy mood="happy" />
      </div>
      {children}
    </section>
  );
}

/** First pass: pick a blueprint, try it on a phone, release. Replaces the checklist. */
export function FirstPassCard({
  orgId,
  setup,
}: {
  orgId: string;
  setup: MetricsOverview['setup'];
}) {
  const at: PathStep | null = currentStep(setup);
  return (
    <Seat label="First pass">
      <div className="flex flex-col gap-6 px-4 pt-10 pb-6 sm:px-8">
        <h2 className="text-center text-lg font-semibold text-fg-strong">First pass</h2>
        <Track setup={setup} />
        {at === 'blueprint' ? (
          <>
            <FirstPassTiles orgId={orgId} />
            <div className="text-center">
              <Button asChild variant="ghost" iconEnd={<ChevronRight aria-hidden />}>
                <Link to="/admin/o/$orgId/blueprints" params={{ orgId }}>
                  All blueprints
                </Link>
              </Button>
            </div>
          </>
        ) : (
          <div className="flex justify-center">
            <TemplateStep orgId={orgId} />
          </div>
        )}
      </div>
    </Seat>
  );
}

function NextTile({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="flex items-center gap-3">
      <span aria-hidden className="fp-next-icon grid size-9 place-items-center rounded-md">
        {icon}
      </span>
      <span className="flex-1 text-left font-medium text-fg-strong">{children}</span>
      <ChevronRight aria-hidden className="size-4 text-fg-muted" />
    </span>
  );
}

/** Once the path is done: the three next things, in a card the viewer can close. */
export function NextRow({ orgId, onDismiss }: { orgId: string; onDismiss: () => void }) {
  const { own } = useOwnTemplate(orgId, true);
  const tile =
    'fp-next block rounded-lg border border-border bg-surface-raised p-3 wl-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';
  return (
    <Seat label="Next">
      <div className="relative px-4 pt-10 pb-6 sm:px-8">
        <IconButton
          label="Close"
          icon={<X aria-hidden />}
          variant="ghost"
          className="absolute top-3 right-3"
          onClick={onDismiss}
        />
        <h2 className="mb-5 text-center text-lg font-semibold text-fg-strong">
          First pass is live
        </h2>
        <div className="grid gap-3 md:grid-cols-3">
          <Link to="/admin/o/$orgId/passes/new" params={{ orgId }} className={tile}>
            <NextTile icon={<Plus className="size-4" />}>New pass</NextTile>
          </Link>
          <Link to="/admin/o/$orgId/passes/import" params={{ orgId }} className={tile}>
            <NextTile icon={<Upload className="size-4" />}>Import</NextTile>
          </Link>
          {own ? (
            <Link
              to="/admin/o/$orgId/templates/$templateId"
              params={{ orgId, templateId: own.id }}
              className={tile}
            >
              <NextTile icon={<Link2 className="size-4" />}>Join link</NextTile>
            </Link>
          ) : null}
        </div>
      </div>
    </Seat>
  );
}
