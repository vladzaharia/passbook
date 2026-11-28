import { type ComponentType, lazy, type ReactNode, type Ref, Suspense, useMemo } from 'react';
import { cn } from '../lib/cn.ts';
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
import './state-view.css';

/** Where it sits: a card or feed row, a page panel, a centred stage, a hosted card. */
export type StateSize = 'inline' | 'panel' | 'stage' | 'hosted';
/** What it says. Failed is `system` (slate, the only tone that offers Try again); forbidden is slate. */
export type StateKind = 'empty' | 'filtered' | 'failed' | 'not-found' | 'no-access' | 'loading';
export type StateTone = 'neutral' | 'system' | 'slate';

const TONE: Record<StateKind, StateTone> = {
  empty: 'neutral',
  filtered: 'neutral',
  'not-found': 'neutral',
  loading: 'neutral',
  failed: 'system',
  'no-access': 'slate',
};

/** The Workbench's dot-grid canvas (kept for the Workbench until its states move). */
export const STAGE_SURFACE =
  'rounded-lg border border-border bg-surface-sunken bg-[radial-gradient(color-mix(in_oklab,var(--pk-border-strong)_38%,transparent)_1px,transparent_1.2px)] bg-size-[16px_16px]';

const SURFACE: Record<StateTone, string> = {
  neutral: 'rounded-lg border border-border',
  system:
    'rounded-lg border border-(--pk-slate-line) bg-(--pk-slate-bg) text-(--pk-slate-fg) shadow-[var(--wl-edge)]',
  slate: 'rounded-lg border border-(--pk-slate-line) bg-(--pk-slate-bg)',
};

const PAD: Record<StateSize, string> = {
  inline: 'gap-1.5 px-4 py-6',
  panel: 'gap-2 px-6 py-10',
  stage: 'gap-3 px-6 py-14',
  hosted: 'gap-3 px-6 py-12',
};

/** Not found and forbidden: the SSR pages' compositions (art/state-acts.ts), always sad. */
function actedOf(art: ArtName, artState: WalletState | undefined): ActedState | undefined {
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

export interface StateViewProps {
  size?: StateSize;
  state?: StateKind;
  /** The entity's art; there is no generic picture. */
  art?: ArtName;
  /** A drawn prop in place of the entity art (the pulled plug), with the scene it acts out. */
  picture?: ReactNode;
  scene?: BuddyScene;
  /** Loads the art on demand, so an entry that never shows it does not carry it (scan). */
  artLoader?: () => Promise<{ default: ComponentType }>;
  /** The mascot's pose when art is "wallet". */
  artState?: WalletState;
  mood?: WalletMood;
  /** The art shows its final frame (another art on the screen has the moment). */
  still?: boolean;
  /** A change replays the buddy's scene (Try again). */
  replay?: number;
  artRef?: Ref<HTMLDivElement>;
  title: string;
  /** One line at most: what happened, or what to do. */
  line?: ReactNode;
  /** The one primary action. */
  action?: ReactNode;
  /** An optional link beside it. */
  secondary?: ReactNode;
  /** The title is the page h1 (not found, forbidden). */
  heading?: boolean;
  /** Reads out as an alert (failed). */
  alert?: boolean;
  /** Below the action: the request id under Details. */
  children?: ReactNode;
  /** The Workbench canvas in place of the border (until its states move). */
  canvas?: boolean;
  className?: string;
}

/**
 * The one renderer for empty, filtered, failed, not found, no access and loading: the buddy and its
 * prop, a title, at most one line, one action and an optional link. Inline keeps the small art
 * alone, so a view never shows more than one buddy. Loading is a `Checking…` band, no art. It
 * fades in (120 ms under reduced motion).
 */
export function StateView({
  size = 'panel',
  state = 'empty',
  art = 'passes',
  picture,
  scene: sceneProp,
  artLoader,
  artState,
  mood,
  still = false,
  replay,
  artRef,
  title,
  line,
  action,
  secondary,
  heading = false,
  alert = false,
  children,
  canvas = false,
  className,
}: StateViewProps) {
  const tone = TONE[state];
  const filtered = state === 'filtered';
  const inline = size === 'inline';
  const Title = heading ? 'h1' : 'p';
  const Loaded = useMemo(() => (artLoader ? lazy(artLoader) : null), [artLoader]);
  const acted = filtered ? undefined : actedOf(art, artState);
  const scene = sceneProp ?? (acted ? ACTED_STATES[acted].scene : sceneFor(art, filtered));

  const root = cn(
    'wl-state relative flex flex-col items-center text-center',
    inline ? '' : canvas ? STAGE_SURFACE : SURFACE[tone],
    PAD[size],
    // The search walk spans a share of the box's width.
    !inline && scene === 'search' && '[container-type:inline-size]',
    className,
  );
  const attrs = {
    'data-testid': 'state-view',
    'data-state': state,
    'data-size': size,
    'data-tone': tone,
  };

  if (state === 'loading') {
    return (
      <div {...attrs} role="status" className={cn(root, 'text-sm font-medium text-fg-strong')}>
        {title}
      </div>
    );
  }

  const picked = Loaded ? (
    <Suspense fallback={null}>
      <Loaded />
    </Suspense>
  ) : (
    (picture ?? (
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
    ))
  );

  return (
    <div {...attrs} data-art-host="" className={root}>
      {inline ? (
        <div ref={artRef} className="relative mb-1">
          {picked}
        </div>
      ) : (
        // The buddy stands on a zero-height floor under its own height, inside the box.
        <div ref={artRef} aria-hidden className="relative mt-[4.5rem] mb-1 h-0 w-full">
          <Buddy
            mood={acted || state === 'failed' ? 'sad' : (mood ?? (heading ? 'sad' : 'curious'))}
            still={still}
            scene={scene}
            {...(replay === undefined ? {} : { replay })}
            {...(art === 'wallet' && !picture && !Loaded
              ? { state: artState ?? 'empty' }
              : { prop: <span className="relative block">{picked}</span> })}
          />
        </div>
      )}
      <div
        role={alert ? 'alert' : undefined}
        className={cn('flex flex-col items-center', inline ? 'gap-1.5' : 'gap-2')}
      >
        <Title
          tabIndex={heading ? -1 : undefined}
          className={cn(
            size === 'stage' || size === 'hosted' || heading
              ? 'text-2xl font-semibold tracking-[-0.015em] text-fg-strong'
              : 'text-sm font-medium text-fg-strong',
          )}
        >
          {title}
        </Title>
        {line ? <p className="max-w-[65ch] text-sm text-fg-muted">{line}</p> : null}
      </div>
      {action || secondary ? (
        // Below sm every action is the row's width, so two states line up.
        <div
          className={cn(
            'flex flex-wrap items-center justify-center gap-2 max-sm:w-full max-sm:[&>*]:w-full',
            inline ? 'mt-1' : 'mt-2',
          )}
        >
          {action}
          {secondary}
        </div>
      ) : null}
      {children}
    </div>
  );
}
