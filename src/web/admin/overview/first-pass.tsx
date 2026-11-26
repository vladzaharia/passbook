import { Link } from '@tanstack/react-router';
import { ChevronRight, Link2, Plus, Upload, X } from 'lucide-react';
import { type CSSProperties, type ReactNode, useCallback, useEffect, useId, useState } from 'react';
import type { MetricsOverview } from '@/shared/contracts/metrics.ts';
import { cn } from '@/web/lib/cn.ts';
import {
  Buddy,
  Button,
  Celebrate,
  IconButton,
  Skeleton,
  StepMarker,
  Tick,
} from '@/web/ui/index.ts';
import { useTemplate, useTemplates } from '../templates/api.ts';
import { nextAction } from '../templates/releases/next-action.ts';
import { BrandRow } from './first-pass-brand.tsx';
import { currentStep, PATH_STEPS, progress, stepDone } from './first-pass-state.ts';
import { FirstPassTiles } from './first-pass-tiles.tsx';
import './first-pass.css';

const dismissKey = (orgId: string) => `wallet-first-pass-next-dismissed:${orgId}`;
const seenKey = (orgId: string) => `wallet-first-pass-seen:${orgId}`;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Storage blocked: nothing remembered, so nothing replays and the row shows until the page is left.
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // See read; the page still works.
  }
}

/** Per viewer and organization: once closed, this browser shows that organization's charts alone. */
export function useNextRowDismissed(orgId: string | undefined): [boolean, () => void] {
  const key = orgId ? dismissKey(orgId) : undefined;
  const [dismissed, setDismissed] = useState(() => (key ? read(key) === '1' : false));
  const dismiss = useCallback(() => {
    setDismissed(true);
    if (key) write(key, '1');
  }, [key]);
  return [dismissed, dismiss];
}

/**
 * Steps finish on other pages, so the change is found on return: the progress last seen here is
 * kept per organization. Returns it when the path has moved since (and the page has to show it),
 * else null; the row's first appearance returns 3 of 3 the same way.
 */
function useSeenProgress(orgId: string, now: number): number | null {
  const [from] = useState(() => {
    const seen = Number(read(seenKey(orgId)));
    return read(seenKey(orgId)) !== null && now > seen ? seen : null;
  });
  useEffect(() => write(seenKey(orgId), String(now)), [orgId, now]);
  return from;
}

/** Three steps on one line: done ones check, the current one is ringed, later ones wait. */
function Track({ setup, from }: { setup: MetricsOverview['setup']; from: number | null }) {
  const at = currentStep(setup);
  return (
    <ol className="fp-track m-0 grid list-none grid-cols-3 p-0">
      {PATH_STEPS.map((s, i) => {
        const done = stepDone(setup, s.id);
        const state = done ? 'done' : s.id === at ? 'now' : 'later';
        // A step finished since the last visit draws itself, and its connector grows after it.
        const fresh = done && from !== null && i >= from;
        return (
          <li
            key={s.id}
            data-state={state}
            aria-current={state === 'now' ? 'step' : undefined}
            className="fp-step relative flex flex-col items-center gap-2 text-center"
          >
            {i > 0 && stepDone(setup, PATH_STEPS[i - 1]?.id ?? 'blueprint') ? (
              <span
                aria-hidden
                className="fp-seg"
                data-fresh={(from !== null && i - 1 >= from) || undefined}
              />
            ) : null}
            <StepMarker
              state={state === 'now' ? 'current' : state === 'done' ? 'done' : 'todo'}
              n={i + 1}
              size="lg"
              fresh={fresh}
            />
            <span
              className={cn(
                'relative text-sm font-medium',
                state === 'later' ? 'text-fg-muted' : 'text-fg-strong',
              )}
            >
              {s.label}
              {done ? <span className="sr-only"> (done)</span> : null}
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
      <Link
        to="/admin/o/$orgId/templates/$templateId"
        params={{ orgId, templateId: own.id }}
        search={action.kind === 'try' ? { try: '1' } : {}}
      >
        {action.kind === 'pass' || action.kind === 'wait' ? 'Open template' : action.label}
      </Link>
    </Button>
  );
}

/** The seated buddy on a card edge. One per screen; decorative. It cheers when the path moved. */
function Seat({
  children,
  labelledBy,
  cheer,
}: {
  children: ReactNode;
  labelledBy: string;
  cheer: boolean;
}) {
  return (
    <section aria-labelledby={labelledBy} className="fp-card relative mt-[4.5rem]">
      <div aria-hidden>
        <Buddy mood="happy" {...(cheer ? { scene: 'cheer' as const, immediate: true } : {})} />
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
  const at = currentStep(setup);
  const from = useSeenProgress(orgId, progress(setup));
  const title = useId();
  return (
    <Seat labelledBy={title} cheer={from !== null}>
      <div className="flex flex-col gap-6 px-4 pt-10 pb-6 sm:px-8">
        <h2 id={title} className="text-center text-lg font-semibold text-fg-strong">
          First pass
        </h2>
        <Track setup={setup} from={from} />
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
        <BrandRow orgId={orgId} />
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

/** Once the path is done: the payoff, the three next things, in a card the viewer can close. */
export function NextRow({
  orgId,
  setup,
  onDismiss,
}: {
  orgId: string;
  setup: MetricsOverview['setup'];
  onDismiss: () => void;
}) {
  const { own } = useOwnTemplate(orgId, true);
  // Arriving here from an unfinished path is the moment: the buddy cheers, sparks fly once.
  const from = useSeenProgress(orgId, 3);
  const title = useId();
  const tile =
    'fp-next block rounded-lg border border-border bg-surface-raised p-3 wl-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';
  return (
    <Seat labelledBy={title} cheer={from !== null}>
      <div className="relative px-4 pt-10 pb-6 sm:px-8">
        <IconButton
          label="Close"
          icon={<X aria-hidden />}
          variant="ghost"
          className="absolute top-3 right-3"
          onClick={onDismiss}
        />
        <h2
          id={title}
          className="relative mx-auto mb-3 w-fit text-center text-lg font-semibold text-fg-strong"
        >
          First pass is live
          <Celebrate when={from !== null} radius={90} />
        </h2>
        <ul className="m-0 mb-5 flex list-none flex-wrap justify-center gap-x-5 gap-y-1 p-0 text-sm text-fg-muted">
          {PATH_STEPS.filter((step) => stepDone(setup, step.id)).map((step) => (
            <li key={step.id} className="flex items-center gap-1.5">
              <Tick className="size-4 text-accent-fg" />
              {step.done}
            </li>
          ))}
        </ul>
        <div className="wl-deal grid gap-3 md:grid-cols-3">
          <Link
            to="/admin/o/$orgId/passes/new"
            params={{ orgId }}
            className={tile}
            style={{ '--i': 0 } as CSSProperties}
          >
            <NextTile icon={<Plus className="size-4" />}>New pass</NextTile>
          </Link>
          <Link
            to="/admin/o/$orgId/passes/import"
            params={{ orgId }}
            className={tile}
            style={{ '--i': 1 } as CSSProperties}
          >
            <NextTile icon={<Upload className="size-4" />}>Import</NextTile>
          </Link>
          {own ? (
            <Link
              to="/admin/o/$orgId/templates/$templateId"
              params={{ orgId, templateId: own.id }}
              className={tile}
              style={{ '--i': 2 } as CSSProperties}
            >
              <NextTile icon={<Link2 className="size-4" />}>Join link</NextTile>
            </Link>
          ) : null}
        </div>
        <div className="mt-3">
          <BrandRow orgId={orgId} />
        </div>
      </div>
    </Seat>
  );
}
