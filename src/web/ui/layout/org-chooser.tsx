import { useNavigate, useRouterState } from '@tanstack/react-router';
import { type KeyboardEvent, type ReactNode, type Ref, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn.ts';
import { pluralize } from '../../lib/format.ts';
import { inViewTransition } from '../../lib/motion.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { parseAdminPath } from '../../lib/scope.ts';
import { readTabScope, useRememberedScope } from '../../lib/scope-store.ts';
import { useSession } from '../../lib/session.ts';
import { Buddy, EntityArt } from '../art/index.ts';
import { FilteredEmpty } from '../empty-state.tsx';
import { ErrorState } from '../error-state.tsx';
import { FilterBar } from '../filter-bar.tsx';
import {
  type Choice,
  chooserMemberships,
  columnsOf,
  gridStep,
  matchesChoice,
  orderChoices,
} from './org-chooser-model.ts';
import { KeycardSkeleton, OrgKeycard } from './org-keycard.tsx';
import './org-chooser.css';

const C = {
  choose: 'Choose an organization',
  none: 'No organizations',
  noneHint: 'Ask an organization admin to invite you.',
  find: 'Find an organization',
  list: 'Organizations',
  loading: 'Loading organizations',
} as const;

/** The filter shows once there are more organizations than this. */
const FILTER_FROM = 6;
const GRID =
  'wl-kc-list mt-6 grid gap-3 sm:grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] sm:gap-4';

export interface OrgChooserProps {
  /** The section to open in the chosen organization ('/passes'). Default: this page's own. */
  next?: string;
  /** A page's own words, where it truly differs ("Choose an organization to import passes"). */
  title?: string;
  /** Inside a page that has its own h1 (a tab): an h2 title and no buddy. */
  inline?: boolean;
}

/**
 * The one way to pick an organization when a page has none: /admin and every org-scoped page.
 * A lobby band (title, filter, the buddy on its edge) over the organizations as badges. Choosing
 * one opens this section there, else the first section its roles open.
 */
export function OrgChooser({ next, title = C.choose, inline = false }: OrgChooserProps) {
  const scope = useOrgScope();
  const { isAdmin } = useSession();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const remembered = useRememberedScope();
  const [query, setQuery] = useState('');
  const find = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const navigate = useNavigate();
  const here = parseAdminPath(pathname);
  const section = next ?? (here.scope?.kind === 'org' ? here.rest : '');
  // A page in an organization it cannot use offers the others; the same one would land here again.
  const offered = chooserMemberships(scope.memberships);
  const others = offered.filter((m) => m.orgId !== scope.requestedOrgId);
  const memberships = others.length > 0 ? others : offered;
  const last = readTabScope() ?? remembered;
  const choices = orderChoices(memberships, { next: section, platform: isAdmin, last });
  const shown = choices.filter((c) => matchesChoice(c, query));
  const Title = inline ? 'h2' : 'h1';

  if (scope.isLoading) return <ChooserSkeleton />;
  if (scope.isError) {
    return <ErrorState subject="organization access" error={scope.error} onRetry={scope.refetch} />;
  }
  const none = memberships.length === 0;
  const filtering = memberships.length > FILTER_FROM;
  const unmatched = shown.length === 0;
  const firstCard = () => list.current?.querySelector<HTMLAnchorElement>('a[data-choice]');
  const onFindKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!(e.target instanceof HTMLInputElement)) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      firstCard()?.focus();
    } else if (e.key === 'Enter' && shown[0]) {
      e.preventDefault();
      void navigate({ to: shown[0].to });
    }
  };
  const onGridKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const links = [...e.currentTarget.querySelectorAll<HTMLAnchorElement>('a[data-choice]')];
    const index = links.indexOf(e.target as HTMLAnchorElement);
    if (index < 0) return;
    const step = gridStep(e.key, index, links.length, columnsOf(links));
    if (step === undefined) return;
    e.preventDefault();
    if (step === 'up') find.current?.querySelector('input')?.focus();
    else links[step]?.focus();
  };

  return (
    <>
      <Lobby
        inline={inline}
        buddy={
          none ? (
            <Buddy
              size="lg"
              at="end"
              mood="sad"
              scene="inspect"
              prop={<EntityArt name="building" size="sm" />}
            />
          ) : (
            <Buddy
              size="lg"
              at="end"
              mood={unmatched ? 'sad' : undefined}
              scene={unmatched ? 'sorry' : 'nudge'}
              replay={unmatched ? 1 : 0}
            />
          )
        }
      >
        <div className="min-w-0 flex-1 basis-56">
          <Title
            tabIndex={-1}
            className={cn(
              'font-semibold text-fg-strong',
              inline ? 'text-base' : 'text-2xl tracking-[-0.015em]',
            )}
          >
            {none ? C.none : title}
          </Title>
          {none && !isAdmin ? <p className="mt-1 text-sm text-fg-muted">{C.noneHint}</p> : null}
        </div>
        {filtering ? (
          // biome-ignore lint/a11y/noStaticElementInteractions: the keys come from the search field inside; Down enters the badges, Enter opens the first.
          <div ref={find} onKeyDown={onFindKey} className="min-w-0 max-sm:basis-full">
            <FilterBar
              className="mb-0"
              filters={[]}
              onClear={() => setQuery('')}
              search={{ value: query, onChange: setQuery, placeholder: C.find }}
            />
          </div>
        ) : null}
      </Lobby>
      {filtering ? (
        <p role="status" className="sr-only">
          {pluralize(shown.length, 'organization')}
        </p>
      ) : null}
      {unmatched && !none ? (
        <FilteredEmpty entity="org" inline onClear={() => setQuery('')} />
      ) : shown.length > 0 ? (
        <KeycardGrid ref={list} choices={shown} onKeyDown={onGridKey} />
      ) : null}
    </>
  );
}

/** The band the buddy sits on: the title at its start, the filter at its end. */
function Lobby({
  inline,
  buddy,
  children,
}: {
  inline: boolean;
  buddy: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      data-art-host=""
      className={cn(
        'wl-kc-lobby relative rounded-lg border border-border bg-surface-raised px-4 py-4 shadow-elevation-1 sm:px-6 sm:py-5',
        !inline && 'wl-buddy-room',
      )}
    >
      {inline ? null : buddy}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">{children}</div>
    </section>
  );
}

/** The badges. They swing in once as the grid mounts (not on a route's fade, not on a filter). */
function KeycardGrid({
  choices,
  onKeyDown,
  ref,
}: {
  choices: readonly Choice[];
  onKeyDown: (e: KeyboardEvent<HTMLUListElement>) => void;
  ref: Ref<HTMLUListElement>;
}) {
  const [enter, setEnter] = useState(() => !inViewTransition());
  useEffect(() => {
    const t = setTimeout(() => setEnter(false), 1000);
    return () => clearTimeout(t);
  }, []);
  return (
    <ul
      ref={ref}
      aria-label={C.list}
      data-enter={enter ? '' : undefined}
      onKeyDown={onKeyDown}
      className={GRID}
    >
      {choices.map((choice, i) => (
        <OrgKeycard key={choice.key} choice={choice} index={i} />
      ))}
    </ul>
  );
}

function ChooserSkeleton() {
  return (
    <div role="status" aria-busy>
      <span className="sr-only">{C.loading}</span>
      <div className="wl-buddy-room [--wl-buddy-room:5.5rem]">
        <div className="wl-skeleton h-[4.75rem] rounded-lg bg-state-hover-tint" />
      </div>
      <ul aria-hidden className={GRID}>
        <KeycardSkeleton />
        <KeycardSkeleton />
        <KeycardSkeleton className="max-sm:hidden" />
      </ul>
    </div>
  );
}
