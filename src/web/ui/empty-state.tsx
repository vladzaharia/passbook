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
import { Button } from './button.tsx';

export interface EmptyStateProps {
  /** Every empty state names its art; there is no generic picture. */
  art: ArtName;
  /** The mascot's pose when art is "wallet". */
  artState?: WalletState;
  /** The buddy's mood (not inline): sad on a heading (not found, forbidden), else curious. */
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
  className?: string;
}

/** What the buddy acts out over each kind of empty box (art/buddy.tsx). */
function sceneFor(art: ArtName, artState: WalletState | undefined, filtered: boolean): BuddyScene {
  if (art === 'wallet') return artState === 'lost' ? 'peek' : 'search';
  if (filtered) return 'sweep';
  if (art === 'torn') return 'mend';
  if (art === 'lock') return 'tug';
  if (art === 'log') return 'flip';
  return 'inspect';
}

/**
 * Not inline, the buddy sits on the box's top edge with the entity's art beside it; inline keeps
 * the entity art alone, so a view never shows more than one buddy.
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
  className,
}: EmptyStateProps) {
  const filtered = variant === 'filtered';
  const Title = heading ? 'h1' : 'p';
  const scene = sceneFor(art, artState, filtered);
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
          : 'mt-18 gap-2 rounded-lg border border-dashed border-border-strong px-6 pt-8 pb-10',
        // The search walk spans a share of the box's width.
        !inline && scene === 'search' && '[container-type:inline-size]',
        className,
      )}
    >
      {inline ? (
        <div className="relative mb-1">{picture}</div>
      ) : (
        <Buddy
          mood={mood ?? (heading ? 'sad' : 'curious')}
          still={still}
          scene={scene}
          {...(art === 'wallet'
            ? { state: artState ?? 'empty' }
            : { prop: <span className="relative block">{picture}</span> })}
        />
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
      {action ? <div className={inline ? 'mt-1' : 'mt-2'}>{action}</div> : null}
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
  /** The list the way back leads to. */
  to: string;
  /** The way back's words when the list is not the entity's plural: "My passes". */
  back?: string;
  /** No PageHeader above it: the title is the page h1. */
  heading?: boolean;
  /** A holder's own pass that is gone: the buddy looks for it with its lens (lost, peek). */
  lost?: boolean;
}

/**
 * An item that is not there (deleted, mistyped link): the torn pass the buddy mends, "{Entity} not
 * found" and one way back to its list.
 */
export function DetailNotFound({ entity, to, back, heading = false, lost }: DetailNotFoundProps) {
  const { label, plural } = ENTITY[entity];
  return (
    <EmptyState
      {...(lost ? { art: 'wallet' as const, artState: 'lost' as const } : { art: 'torn' as const })}
      mood="sad"
      heading={heading}
      title={notFoundTitle(label)}
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
