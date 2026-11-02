import type { ReactNode } from 'react';
import { cn } from '../lib/cn.ts';
import { ENTITY, type EntityKind } from '../lib/entities.ts';
import { type ArtName, EntityArt, LensOverlay, type WalletState } from './art/index.ts';
import { Button } from './button.tsx';

export interface EmptyStateProps {
  /** Every empty state names its art; there is no generic picture. */
  art: ArtName;
  /** The mascot's pose when art is "wallet". */
  artState?: WalletState;
  title: string;
  /** One action: outline for navigation, primary only for create. */
  action?: ReactNode;
  /** One line at most. */
  description?: ReactNode;
  /** filtered: the art dims under a lens ("No passes match", Clear filters). */
  variant?: 'empty' | 'filtered';
  /** The art shows its final frame (another art on the screen has the moment). */
  still?: boolean;
  /** Inside a card: no border, small art, py-6. */
  inline?: boolean;
  /** Not-found and forbidden pages: the title is the page h1. */
  heading?: boolean;
  className?: string;
}

export function EmptyState({
  art,
  artState,
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
  return (
    <div
      data-art-host=""
      className={cn(
        'flex flex-col items-center text-center',
        inline
          ? 'gap-1.5 px-4 py-6'
          : 'gap-2 rounded-lg border border-dashed border-border-strong px-6 py-10',
        className,
      )}
    >
      <div className={cn('relative', inline ? 'mb-1' : 'mb-2')}>
        <EntityArt
          name={art}
          size={inline ? 'sm' : 'lg'}
          className={filtered ? 'opacity-60' : undefined}
          still={still}
          {...(artState ? { state: artState } : {})}
        />
        {filtered ? (
          <LensOverlay
            size={inline ? 'sm' : 'lg'}
            className="absolute right-0 bottom-0 origin-bottom-right translate-x-1/4 scale-60"
          />
        ) : null}
      </div>
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
