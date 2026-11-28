import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { backTo, notFoundTitle } from '@/shared/copy/states.ts';
import { ENTITY, type EntityKind } from '../lib/entities.ts';
import type { ArtName, WalletMood, WalletState } from './art/index.ts';
import { Button } from './button.tsx';
import { type StateKind, StateView } from './state-view.tsx';

export { STAGE_SURFACE } from './state-view.tsx';

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
  /** Replaces the title's type (the Workbench sets one scale for its states). */
  titleClassName?: string;
  className?: string;
}

const stateOf = (art: ArtName, variant: 'empty' | 'filtered'): StateKind =>
  variant === 'filtered'
    ? 'filtered'
    : art === 'lock'
      ? 'no-access'
      : art === 'torn'
        ? 'not-found'
        : 'empty';

/** Adapter over StateView (the one renderer): the old props, until importers move. */
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
  return (
    <StateView
      size={inline ? 'inline' : surface === 'stage' ? 'stage' : 'panel'}
      state={stateOf(art, variant)}
      art={art}
      {...(artState ? { artState } : {})}
      {...(mood ? { mood } : {})}
      title={title}
      line={description}
      action={action}
      heading={heading}
      still={still}
      canvas={surface === 'stage' && art !== 'lock'}
      {...(titleClassName ? { titleClassName } : {})}
      className={className}
    />
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
