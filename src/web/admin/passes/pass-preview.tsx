import { type ReactNode, useMemo, useState } from 'react';
import type { PassJson } from '@/passkit/types.ts';
import { normalize, type PassView } from '@/shared/pass-view/index.ts';
import { cn } from '../../lib/cn.ts';
import { useChangeCount } from '../../lib/motion.ts';
import { assetUrlMap } from '../../pass-card/assets.ts';
import { PassCardStage } from '../../pass-card/index.tsx';
import { Badge } from '../../ui/badge.tsx';
import { Celebrate } from '../../ui/celebrate.tsx';
import { LoadingRail } from '../../ui/loading-rail.tsx';
import {
  type PassSide,
  PassSideToggle,
  type PassTarget,
  PassTargetToggle,
} from '../../ui/pass-toggles.tsx';

/** Asset names to URLs under the base; all candidates when the API sends no list. */
export function assetMap(assetBaseUrl: string, names?: readonly string[]): Record<string, string> {
  return assetUrlMap(assetBaseUrl, names);
}

/** The kit toggle speaks '27' | 'legacy'; the pass view speaks 'ios27' | 'legacy'. */
/**
 * A new pass's card glides in from the wizard's preview (the view transition) and deals in over
 * --wl-dur-card (480 ms): the sparks wait for it to land, so they burst where it settles.
 */
export const CARD_LANDS_MS = 520;

export const viewTarget = (t: PassTarget) => (t === '27' ? 'ios27' : 'legacy');

export function usePassView(
  passJson: Record<string, unknown>,
  assetBaseUrl: string,
  assetNames?: readonly string[],
  removed = false,
  urls?: Record<string, string> | undefined,
): PassView | null {
  return useMemo(() => {
    try {
      // A voided or removed pass shows no barcode, as on the hosted page, and its status field
      // reads the state, not the template's "Active".
      const ended = passJson.voided === true || removed;
      const { barcode: _b, barcodes: _bs, ...bare } = passJson;
      const view = normalize((ended ? bare : passJson) as unknown as PassJson, {
        assets: urls ?? assetMap(assetBaseUrl, assetNames),
        ...(removed ? { stateWord: 'Removed' } : {}),
      });
      // A removed pass is stored voided: no stamp, as on the holder's pages; the card is greyed and reads Removed.
      return removed ? { ...view, invalid: null } : view;
    } catch {
      // A malformed pass.json must not take the page down; callers show the fallback line.
      return null;
    }
  }, [passJson, assetBaseUrl, assetNames, removed, urls]);
}

export interface PassPreviewProps {
  passJson: Record<string, unknown>;
  assetBaseUrl: string;
  /** Image URLs that replace the base's own (a logo chosen but not yet saved). */
  assetUrls?: Record<string, string> | undefined;
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
  /** Removed from Wallet: the card reads Expired, not Voided. */
  removed?: boolean;
  /** A sandbox pass: the TEST PREVIEW band across the card. */
  testBand?: boolean;
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
  assetUrls,
  face = 'front',
  target = '27',
  flippable = false,
  mint,
  settle,
  dim,
  removed = false,
  testBand,
  enter,
  still = false,
  transitionName,
  className,
}: PassPreviewProps) {
  const view = usePassView(passJson, assetBaseUrl, assetNames, removed, assetUrls);
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
      testBand={testBand}
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
  celebrate = false,
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
  /** Foil sparks fly once from the card's centre: the org's first pass. */
  celebrate?: boolean;
}) {
  const [face, setFace] = useState<PassSide>('front');
  const [target, setTarget] = useState<PassTarget>('27');
  const view = usePassView(
    preview.passJson,
    preview.assetBaseUrl,
    preview.assetNames,
    preview.removed,
    preview.assetUrls,
  );
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
        <Celebrate when={celebrate} size="lg" delay={CARD_LANDS_MS} />
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
