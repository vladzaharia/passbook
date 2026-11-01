import { useEffect, useMemo, useState } from 'react';
import type { PassJson } from '@/passkit/types.ts';
import { normalize } from '@/shared/pass-view/index.ts';
import { cn } from '../../lib/cn.ts';
import { assetUrlMap } from '../../pass-card/assets.ts';
import { PassCardStage } from '../../pass-card/index.tsx';
import { PassSideToggle, PassTargetToggle, usePassFacesDiffer } from '../../ui/index.ts';

/** Asset names to URLs under the base; all candidates when the API sends no list. */
export function assetMap(assetBaseUrl: string, names?: readonly string[]): Record<string, string> {
  return assetUrlMap(assetBaseUrl, names);
}

export type IosTarget = '27' | 'legacy';

/** Before iOS 27 the classic style key wins; dropping the scheme list previews that. */
export function forTarget(passJson: Record<string, unknown>, target: IosTarget) {
  if (target === '27') return passJson;
  const { preferredStyleSchemes: _drop, ...rest } = passJson;
  return rest;
}

export interface PassPreviewProps {
  passJson: Record<string, unknown>;
  assetBaseUrl: string;
  /** Image files the pass has, from the API; omit to guess. */
  assetNames?: readonly string[];
  face?: 'front' | 'back';
  target?: IosTarget;
  /** Render both faces so a face change flips the card. */
  flippable?: boolean;
  /** Plays the mint sheen when this changes (by identity). */
  mint?: unknown;
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
  still = false,
  transitionName,
  className,
}: PassPreviewProps) {
  const view = useMemo(() => {
    try {
      return normalize(forTarget(passJson, target) as unknown as PassJson, {
        assets: assetMap(assetBaseUrl, assetNames),
      });
    } catch {
      // A malformed pass.json must not take the page down; the card shows the fallback below.
      return null;
    }
  }, [passJson, assetBaseUrl, assetNames, target]);
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
      flippable={flippable}
      mint={mint}
      tilt={!still}
      glow={!still}
      {...(transitionName ? { transitionName } : {})}
      className={cn('mx-auto w-full max-w-xs', className)}
    />
  );
}

/** Front/back flip plus the iOS 27 / earlier toggle. */
export function PassPreviewPanel({
  passJson,
  assetBaseUrl,
  assetNames,
  transitionName,
  mintOnArrival = false,
  className,
}: {
  passJson: Record<string, unknown>;
  assetBaseUrl: string;
  assetNames?: readonly string[];
  transitionName?: string;
  /** Mint once after mount (a pass that was just created). */
  mintOnArrival?: boolean;
  className?: string;
}) {
  const [face, setFace] = useState<'front' | 'back'>('front');
  const [target, setTarget] = useState<IosTarget>('27');
  const differ = usePassFacesDiffer(passJson);
  const [arrived, setArrived] = useState(false);
  useEffect(() => {
    if (mintOnArrival) setArrived(true);
  }, [mintOnArrival]);
  // A new version (or a fresh pass) mints the card; the same JSON does not.
  // biome-ignore lint/correctness/useExhaustiveDependencies: both values are triggers
  const mint = useMemo(() => ({}), [passJson, arrived]);
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <PassPreview
        passJson={passJson}
        assetBaseUrl={assetBaseUrl}
        {...(assetNames ? { assetNames } : {})}
        face={face}
        target={target}
        flippable
        mint={mint}
        {...(transitionName ? { transitionName } : {})}
      />
      <div className="flex flex-wrap justify-center gap-2">
        <PassSideToggle value={face} onChange={setFace} />
        {differ ? <PassTargetToggle value={target} onChange={setTarget} /> : null}
      </div>
    </div>
  );
}
