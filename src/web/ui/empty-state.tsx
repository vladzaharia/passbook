import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { backTo, notFoundTitle } from '@/shared/copy/states.ts';
import { cn } from '../lib/cn.ts';
import { ENTITY, type EntityKind } from '../lib/entities.ts';
import {
  type ArtName,
  Buddy,
  type BuddyScene,
  EntityArt,
  LensOverlay,
  type WalletMood,
  type WalletState,
} from './art/index.ts';
import { ACTED_STATES, type ActedState } from './art/state-acts.ts';
import { Button } from './button.tsx';
import { Wordmark } from './layout/wordmark.tsx';

export interface EmptyStateProps {
  /** Every empty state names its art; there is no generic picture. */
  art: ArtName;
  /** The mascot's pose when art is "wallet". */
  artState?: WalletState;
  /** The buddy's mood (not inline): sad on a heading, else curious. Not found and forbidden are sad. */
  mood?: WalletMood;
  title: string;
  /** One action: outline for navigation, primary only for create. */
  action?: ReactNode;
  /** One line at most. */
  description?: ReactNode;
  /** filtered: the art dims under a lens ("No passes match", Clear filters). */
  variant?: 'empty' | 'filtered';
  /** The art shows its final frame (another art on the screen has the moment). */
  still?: boolean;
  /** Inside a card: no border, the small entity art alone (no buddy), py-6. */
  inline?: boolean;
  /** Not-found and forbidden pages: the title is the page h1. */
  heading?: boolean;
  /**
   * `stage`: the Workbench's dot-grid canvas in place of the dashed box (design D3). `card`: the
   * hosted pages' card (worker/ssr/hosted.ts): wordmark band, the buddy seated on the card's top
   * edge, the title and action on a solid card. Not found uses it, as the SSR error pages do.
   */
  surface?: 'stage' | 'card';
  className?: string;
}

/** The dot grid a pass stands on: the Workbench's empty canvas. */
export const STAGE_SURFACE =
  'rounded-lg border border-border bg-surface-sunken bg-[radial-gradient(color-mix(in_oklab,var(--pk-border-strong)_38%,transparent)_1px,transparent_1.2px)] bg-size-[16px_16px]';

/** Not found and forbidden: the SSR pages' compositions (art/state-acts.ts), always sad. */
function stateOf(art: ArtName, artState: WalletState | undefined): ActedState | undefined {
  if (art === 'torn') return 'torn';
  if (art === 'lock') return 'no-access';
  if (art === 'wallet' && artState === 'lost') return 'lost';
  return undefined;
}

/** What the buddy acts out over each kind of empty box (art/buddy.tsx). */
function sceneFor(art: ArtName, filtered: boolean): BuddyScene {
  if (art === 'wallet') return 'search';
  if (filtered) return 'sweep';
  if (art === 'log') return 'flip';
  return 'inspect';
}

/**
 * Not inline, the buddy stands inside the box above the title with the entity's art beside it;
 * inline keeps the entity art alone, so a view never shows more than one buddy.
 */
export function EmptyState({
  art,
  artState,
  mood,
  title,
  action,
  description,
  variant = 'empty',
  inline = false,
  heading = false,
  still = false,
  surface,
  className,
}: EmptyStateProps) {
  const filtered = variant === 'filtered';
  const Title = heading ? 'h1' : 'p';
  const state = filtered ? undefined : stateOf(art, artState);
  const scene = state ? ACTED_STATES[state].scene : sceneFor(art, filtered);
  // Filtered: the art dims under a lens. Not inline, the buddy holds it.
  const picture = (
    <>
      <EntityArt
        name={art}
        size="sm"
        className={filtered ? 'opacity-60' : undefined}
        still={still}
        {...(artState ? { state: artState } : {})}
      />
      {filtered ? (
        <LensOverlay
          size="sm"
          still={still}
          className="absolute right-0 bottom-0 origin-bottom-right translate-x-1/4 scale-60"
        />
      ) : null}
    </>
  );
  if (surface === 'card' && !inline) {
    return (
      <div
        className={cn('mx-auto flex w-full max-w-sm flex-col pt-8 pb-10 sm:pt-14', className)}
      >
        <div className="flex items-end justify-between gap-4 ps-[calc(1px+1.25rem)] pe-[calc(1.25rem-17px)] sm:ps-[calc(1px+1.5rem)] sm:pe-[calc(1.5rem-19px)]">
          <div className="flex h-[63px] items-center sm:h-[72px]">
            <Wordmark hello={false} size="lg" />
          </div>
          <div
            aria-hidden
            className="pointer-events-none relative z-20 h-[84px] w-28 flex-none sm:h-24 sm:w-32 [&>.wl-buddy]:top-full! [&>.wl-buddy]:right-0! [&>.wl-buddy]:left-auto! [&>.wl-buddy]:translate-x-0! [&>.wl-buddy]:-translate-y-full!"
          >
            <Buddy
              mood="sad"
              size="xl"
              still={still}
              scene={scene}
              {...(art === 'wallet'
                ? { state: artState ?? 'empty' }
                : { prop: <span className="relative block">{picture}</span> })}
            />
          </div>
        </div>
        <section
          data-art-host=""
          className="wl-foil-edge relative z-10 flex flex-col gap-6 overflow-hidden rounded-xl border border-border bg-surface-raised p-5 shadow-elevation-1 sm:p-6"
        >
          <div>
            <Title
              tabIndex={heading ? -1 : undefined}
              className="text-2xl font-semibold tracking-[-0.015em] text-fg-strong"
            >
              {title}
            </Title>
            {description ? <p className="mt-1 text-sm text-fg-muted">{description}</p> : null}
          </div>
          {action ? <div className="max-sm:[&>*]:w-full">{action}</div> : null}
        </section>
      </div>
    );
  }
  return (
    <div
      data-art-host=""
      className={cn(
        'relative flex flex-col items-center text-center',
        inline
          ? 'gap-1.5 px-4 py-6'
          : cn(
              'gap-2 px-6 py-10',
              surface === 'stage'
                ? STAGE_SURFACE
                : 'rounded-lg border border-dashed border-border-strong',
            ),
        // The search walk spans a share of the box's width.
        !inline && scene === 'search' && '[container-type:inline-size]',
        className,
      )}
    >
      {inline ? (
        <div className="relative mb-1">{picture}</div>
      ) : (
        // The buddy stands on a zero-height floor under its own height, inside the box.
        <div aria-hidden className="relative mt-[4.5rem] mb-1 h-0 w-full">
          <Buddy
            mood={state ? 'sad' : (mood ?? (heading ? 'sad' : 'curious'))}
            still={still}
            scene={scene}
            {...(art === 'wallet'
              ? { state: artState ?? 'empty' }
              : { prop: <span className="relative block">{picture}</span> })}
          />
        </div>
      )}
      <Title
        tabIndex={heading ? -1 : undefined}
        className={cn(
          heading
            ? 'text-2xl font-semibold tracking-[-0.015em] text-fg-strong'
            : 'text-sm font-medium text-fg-strong',
        )}
      >
        {title}
      </Title>
      {description ? <p className="max-w-[65ch] text-sm text-fg-muted">{description}</p> : null}
      {action ? (
        // Below sm every action is the row's width, so two empty states line up.
        <div className={cn(inline ? 'mt-1' : 'mt-2', 'max-sm:w-full max-sm:[&>*]:w-full')}>
          {action}
        </div>
      ) : null}
    </div>
  );
}

/** The filtered-empty state for an entity list: "No passes match" with Clear filters. */
export function FilteredEmpty({
  entity,
  onClear,
  inline,
}: {
  entity: EntityKind;
  onClear: () => void;
  inline?: boolean;
}) {
  const { art, plural } = ENTITY[entity];
  return (
    <EmptyState
      art={art}
      variant="filtered"
      inline={inline}
      title={`No ${plural} match`}
      action={
        <Button variant="ghost" onClick={onClear}>
          Clear filters
        </Button>
      }
    />
  );
}

export interface DetailNotFoundProps {
  entity: EntityKind;
  /** The thing's own name when the entity's is the wrong noun: "Change run". */
  noun?: string;
  /** The list the way back leads to. */
  to: string;
  /** The way back's words when the list is not the entity's plural: "My passes". */
  back?: string;
  /** No PageHeader above it: the title is the page h1. */
  heading?: boolean;
}

/**
 * An item that is not there (deleted, mistyped link): the torn pass the buddy mends, "{Entity} not
 * found" and one way back to its list.
 */
export function DetailNotFound({ entity, noun, to, back, heading = false }: DetailNotFoundProps) {
  const { label, plural } = ENTITY[entity];
  return (
    <EmptyState
      art="torn"
      mood="sad"
      heading={heading}
      title={notFoundTitle(noun ?? label)}
      action={
        <Button asChild variant="outline">
          <Link to={to}>
            <ArrowLeft aria-hidden />
            {backTo(back ?? plural)}
          </Link>
        </Button>
      }
    />
  );
}
