import { useEffect, useMemo, useRef, useState } from 'react';
import type { PassJson } from '@/passkit/types.ts';
import { normalize } from '@/shared/pass-view/index.ts';
import { prefersReducedMotion } from '../../../lib/motion.ts';
import { PassCardStage } from '../../../pass-card/index.tsx';
import { Badge, LoadingRail, type PassSide, PassSideToggle, Skeleton } from '../../../ui/index.ts';
import { previewAssetMap } from './images.ts';
import { allKeys, type DraftAsset } from './model.ts';

/**
 * A field that first shows up in the dry run drops onto the card (translate and scale, 320 ms
 * spring); with reduced motion it fades. The first pass in only seeds the known keys.
 */
function usePartDrop(passJson: Record<string, unknown> | null | undefined) {
  const host = useRef<HTMLDivElement>(null);
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!passJson) return;
    const keys = new Set(allKeys(passJson));
    const before = known.current;
    known.current = keys;
    if (!before || !host.current) return;
    for (const key of keys) {
      if (before.has(key)) continue;
      const el = host.current.querySelector<HTMLElement>(`[data-fk="${CSS.escape(key)}"]`);
      if (!el?.animate) continue;
      const frames = prefersReducedMotion()
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [
            { opacity: 0, transform: 'translateY(-14px) scale(1.08)' },
            { opacity: 1, transform: 'none' },
          ];
      el.animate(frames, {
        duration: prefersReducedMotion() ? 160 : 320,
        easing: prefersReducedMotion() ? 'linear' : 'cubic-bezier(0.34, 1.4, 0.64, 1)',
      });
    }
  }, [passJson]);
  return host;
}

/** The live card with its Front / Details flip, drawn from the dry run's pass and the draft's files. */
export function DesignerPreview({
  passJson,
  assets,
  assetBase,
  checking,
}: {
  passJson: Record<string, unknown> | null | undefined;
  assets: readonly DraftAsset[];
  assetBase: string;
  checking: boolean;
}) {
  const [face, setFace] = useState<PassSide>('front');
  const host = usePartDrop(passJson);
  const view = useMemo(() => {
    if (!passJson) return null;
    try {
      return normalize(passJson as unknown as PassJson, {
        assets: previewAssetMap(assets, assetBase),
      });
    } catch {
      // A pass the card cannot read shows the fallback line; the issues list says why.
      return null;
    }
  }, [passJson, assets, assetBase]);
  return (
    <div className="flex flex-col items-center gap-3" data-testid="designer-preview">
      <div ref={host} className="relative w-full">
        <LoadingRail show={checking} />
        {view ? (
          <PassCardStage
            view={view}
            face={face}
            target="ios27"
            flippable
            tilt
            glow
            className="mx-auto w-full max-w-xs"
          />
        ) : passJson ? (
          <p role="alert" className="text-sm text-danger">
            This pass cannot be previewed. See the issues.
          </p>
        ) : (
          <Skeleton className="mx-auto aspect-[320/420] w-full max-w-xs rounded-xl" />
        )}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <PassSideToggle value={face} onChange={setFace} />
        {view?.layouts.ios27.approximate ? (
          <Badge tone="neutral" title="Wallet lays this style out from its semantics.">
            Approximate
          </Badge>
        ) : null}
      </div>
    </div>
  );
}
