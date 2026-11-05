import { useMemo, useState } from 'react';
import type { PassJson } from '@/passkit/types.ts';
import { normalize } from '@/shared/pass-view/index.ts';
import { PassCardStage } from '../../../pass-card/index.tsx';
import { Badge, LoadingRail, type PassSide, PassSideToggle, Skeleton } from '../../../ui/index.ts';
import { previewAssetMap } from './images.ts';
import type { DraftAsset } from './model.ts';

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
      <div className="relative w-full">
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
