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
  /** `stage`: the Workbench's dot-grid canvas in place of the dashed box (design D3). */
  surface?: 'stage';
  /** Replaces the title's type (the Workbench sets one scale for all its states). */
  titleClassName?: string;
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
  titleClassName,
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
          titleClassName ??
            (heading
              ? 'text-2xl font-semibold tracking-[-0.015em] text-fg-strong'
              : 'text-sm font-medium text-fg-strong'),
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
