import { type ReactNode, useMemo, useState } from 'react';
import type { PassJson } from '@/passkit/types.ts';
import { normalize, type PassView } from '@/shared/pass-view/index.ts';
import { cn } from '../../lib/cn.ts';
import { useChangeCount } from '../../lib/motion.ts';
import { assetUrlMap } from '../../pass-card/assets.ts';
import { PassCardStage } from '../../pass-card/index.tsx';
import {
  Badge,
  LoadingRail,
  type PassSide,
  PassSideToggle,
  type PassTarget,
  PassTargetToggle,
} from '../../ui/index.ts';

/** Asset names to URLs under the base; all candidates when the API sends no list. */
export function assetMap(assetBaseUrl: string, names?: readonly string[]): Record<string, string> {
  return assetUrlMap(assetBaseUrl, names);
}

/** The kit toggle speaks '27' | 'legacy'; the pass view speaks 'ios27' | 'legacy'. */
export const viewTarget = (t: PassTarget) => (t === '27' ? 'ios27' : 'legacy');

export function usePassView(
  passJson: Record<string, unknown>,
  assetBaseUrl: string,
  assetNames?: readonly string[],
): PassView | null {
  return useMemo(() => {
    try {
      return normalize(passJson as unknown as PassJson, {
        assets: assetMap(assetBaseUrl, assetNames),
      });
    } catch {
      // A malformed pass.json must not take the page down; callers show the fallback line.
      return null;
    }
  }, [passJson, assetBaseUrl, assetNames]);
}

export interface PassPreviewProps {
  passJson: Record<string, unknown>;
  assetBaseUrl: string;
  /** Image files the pass has, from the API; omit to guess. */
  assetNames?: readonly string[];
  face?: PassSide;
  target?: PassTarget;
  /** Render both faces so a face change flips the card. */
  flippable?: boolean;
  /** Plays the mint when this changes: new current content only. */
  mint?: unknown;
  /** Settles the card once when this changes (void). */
  settle?: unknown;
  /** The glow fades (voided). */
  dim?: boolean;
  /** Deal in on mount. */
  enter?: boolean;
  /** Off for thumbnails: no pointer tilt, no glow. */
  still?: boolean;
  /** Shared view-transition name, so the card morphs between pages. */
  transitionName?: string;
  className?: string;
}

export function PassPreview({
  passJson,
  assetBaseUrl,
  assetNames,
  face = 'front',
  target = '27',
  flippable = false,
  mint,
  settle,
  dim,
  enter,
  still = false,
  transitionName,
  className,
}: PassPreviewProps) {
  const view = usePassView(passJson, assetBaseUrl, assetNames);
  if (!view) {
    return (
      <p role="alert" className="text-sm text-danger">
        This pass cannot be previewed.
      </p>
    );
  }
  return (
    <PassCardStage
      view={view}
      face={face}
      target={viewTarget(target)}
      flippable={flippable}
      mint={mint}
      settle={settle}
      dim={dim}
      enter={enter}
      tilt={!still}
      glow={!still}
      {...(transitionName ? { transitionName } : {})}
      className={cn('mx-auto w-full max-w-xs', className)}
    />
  );
}

/**
 * The detail preview: the stage, Front / Details, the iOS toggle only when the faces differ, an
 * Approximate chip for semantic layouts, the version as text and the Unsaved ribbon slot.
 */
export function PassPreviewPanel({
  label,
  unsaved,
  waiting,
  swapKey,
  beside,
  seat = false,
  className,
  ...preview
}: Omit<PassPreviewProps, 'face' | 'target' | 'flippable'> & {
  /** "v3": the version shown, as text. */
  label?: ReactNode;
  unsaved?: boolean;
  /** A version is loading: the card holds at .5 after 150 ms. */
  waiting?: boolean;
  /** Changes when another version shows: the new face crossfades in the same box. */
  swapKey?: string | number;
  /** Seated on the Front / Details row's top edge, which leaves room for it (the stage buddy). */
  beside?: ReactNode;
  /**
   * Keep that room from the first frame when a buddy can arrive later (a void), so the row and
   * everything under it never shift.
   */
  seat?: boolean;
}) {
  const [face, setFace] = useState<PassSide>('front');
  const [target, setTarget] = useState<PassTarget>('27');
  const view = usePassView(preview.passJson, preview.assetBaseUrl, preview.assetNames);
  const differ = view?.hasAlternate ?? false;
  const shown = differ ? target : '27';
  const approximate = view?.layouts[viewTarget(shown)].approximate ?? false;
  // The crossfade is for browsing versions; on mount the deal is the only entrance.
  const swapped = useChangeCount(swapKey) > 0;
  return (
    <div className={cn('flex flex-col items-center gap-3', className)}>
      <div className="relative w-full">
        <span className="wl-unsaved" data-on={unsaved || undefined} aria-hidden={!unsaved}>
          <Badge tone="warning">Unsaved</Badge>
        </span>
        <LoadingRail show={Boolean(waiting)} />
        <div className="wl-version-wait" data-waiting={waiting || undefined}>
          <div key={swapKey} className={swapped ? 'wl-version-in' : undefined}>
            <PassPreview {...preview} face={face} target={shown} flippable />
          </div>
        </div>
      </div>
      <div
        className={cn(
          'relative flex flex-wrap items-center justify-center gap-2',
          (seat || Boolean(beside)) && 'mt-8',
        )}
      >
        <PassSideToggle value={face} onChange={setFace} />
        {differ ? <PassTargetToggle value={target} onChange={setTarget} /> : null}
        {beside}
      </div>
      {label || approximate ? (
        <p className="flex items-center gap-2 text-xs text-fg-muted">
          {label ? <span className="tabular-nums">{label}</span> : null}
          {approximate ? (
            <Badge tone="neutral" title="Wallet lays this style out from its semantics.">
              Approximate
            </Badge>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
