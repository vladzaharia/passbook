import { lazy, Suspense, useMemo } from 'react';
import type { PassJson } from '@/passkit/types.ts';
import { normalize } from '@/shared/pass-view/index.ts';
import { FacePair, type PreviewFace } from '../../channel-previews/face-pair.tsx';
import { FitBox } from '../../channel-previews/fit-box.tsx';
import type { PreviewSource } from '../../channel-previews/types.ts';
import type { WalletPreviews } from '../../channel-previews/use-wallet-previews.ts';
import { assetUrlMap } from '../../pass-card/assets.ts';
import { PassCardStage } from '../../pass-card/index.tsx';
import { GoogleCard } from '../../wallet-previews/google/google-card.tsx';
import { SamsungCard } from '../../wallet-previews/samsung/samsung-card.tsx';
import { Skel } from './skel.tsx';

export { Skel };

/** The live sheet carries every paper size's renderer; it loads when a signed-in developer opens Paper. */
const LivePaper = lazy(() => import('./live-paper.tsx'));

/** Apple: the real PassCard, from the pass.json the dry run built; front and back (FacePair). */
export function ApplePane({
  source,
  face,
  onFace,
  label,
}: {
  source: PreviewSource;
  face?: PreviewFace | undefined;
  onFace?: ((face: PreviewFace) => void) | undefined;
  label?: string | undefined;
}) {
  const view = useMemo(() => {
    try {
      return normalize(source.passJson as unknown as PassJson, {
        assets: assetUrlMap(source.assetBaseUrl, source.assetNames),
      });
    } catch {
      // A pass.json the card cannot read: the line below says so, the page stays up.
      return null;
    }
  }, [source.passJson, source.assetBaseUrl, source.assetNames]);
  if (!view)
    return (
      <p role="alert" className="pg-bad">
        This pass cannot be previewed.
      </p>
    );
  const side = (s: PreviewFace) => (
    <PassCardStage view={view} face={s} tilt glow testBand className="pg-apple" />
  );
  return (
    <FacePair face={face} onFace={onFace} label={label} front={side('front')} back={side('back')} />
  );
}

/** Google and Samsung: the cards the real compilers make. Front is the card, back its details. */
export function WalletPane({
  target,
  previews,
  face,
  onFace,
  label,
}: {
  target: 'google' | 'samsung';
  previews: WalletPreviews;
  face?: PreviewFace | undefined;
  onFace?: ((face: PreviewFace) => void) | undefined;
  label?: string | undefined;
}) {
  if (previews.state === 'loading') return <Skel ratio="320/420" />;
  if (previews.state === 'error')
    return (
      <p role="alert" className="pg-bad">
        This pass cannot be previewed in this wallet.
      </p>
    );
  const { compiled } = previews.out[target];
  if (compiled.type === 'off') return <p className="pg-off">Off for this template.</p>;
  if (compiled.blocked) return <p className="pg-off">{compiled.blocked.message}</p>;
  const side = (s: PreviewFace) =>
    target === 'samsung' ? (
      compiled.cardData ? (
        <SamsungCard
          data={compiled.cardData as Parameters<typeof SamsungCard>[0]['data']}
          testBand
          face={s}
        />
      ) : null
    ) : compiled.objectBody ? (
      <GoogleCard
        type={compiled.type}
        classBody={compiled.classBody}
        objectBody={compiled.objectBody}
        testBand
        face={s}
      />
    ) : null;
  return (
    <div className="pg-wallet">
      <FacePair
        face={face}
        onFace={onFace}
        label={label}
        front={side('front')}
        back={side('back')}
      />
    </div>
  );
}

/**
 * Paper: a static image for a visitor, the live sheet for a signed-in developer. Either way the
 * whole page shows, scaled to the room it has and at most `maxHeight` tall.
 */
export function PaperPane({
  source,
  image,
  maxHeight,
}: {
  source: PreviewSource | null;
  image: { src: string; width: number; height: number } | undefined;
  maxHeight: number;
}) {
  if (image)
    return (
      <img
        className="pg-paper-img"
        src={image.src}
        width={image.width}
        height={image.height}
        style={{ maxHeight }}
        alt="The printed ticket, sample"
      />
    );
  return source ? (
    <FitBox maxHeight={maxHeight}>
      <Suspense fallback={<Skel ratio="210/297" />}>
        <LivePaper source={source} />
      </Suspense>
    </FitBox>
  ) : (
    <Skel ratio="210/297" />
  );
}
