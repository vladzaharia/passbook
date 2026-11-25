import { lazy, Suspense, useMemo } from 'react';
import type { PassJson } from '@/passkit/types.ts';
import { normalize } from '@/shared/pass-view/index.ts';
import type { PreviewSource } from '../../channel-previews/types.ts';
import type { WalletPreviews } from '../../channel-previews/use-wallet-previews.ts';
import { assetUrlMap } from '../../pass-card/assets.ts';
import { PassCardStage } from '../../pass-card/index.tsx';
import { GoogleCard } from '../../wallet-previews/google/google-card.tsx';
import { SamsungCard } from '../../wallet-previews/samsung/samsung-card.tsx';
import type { Face } from './hash.ts';
import { Skel } from './skel.tsx';

export { Skel };

/** The live sheet carries every paper size's renderer; it loads when a signed-in developer opens Paper. */
const LivePaper = lazy(() => import('./live-paper.tsx'));

/** Apple: the real PassCard, from the pass.json the dry run built. */
export function ApplePane({ source, face }: { source: PreviewSource; face: Face }) {
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
  return (
    <PassCardStage view={view} face={face} flippable tilt glow testBand className="pg-apple" />
  );
}

/** Google and Samsung: the cards the real compilers make. Front is the card, back its details. */
export function WalletPane({
  target,
  previews,
  face,
}: {
  target: 'google' | 'samsung';
  previews: WalletPreviews;
  face: Face;
}) {
  if (previews.state === 'loading') return <Skel ratio="320/420" />;
  if (previews.state === 'error')
    return (
      <p role="alert" className="pg-bad">
        This pass cannot be previewed in this wallet.
      </p>
    );
  const { compiled } = previews.out[target];
  let card = null;
  if (compiled.type === 'off') card = <p className="pg-off">Off for this template.</p>;
  else if (compiled.blocked) card = <p className="pg-off">{compiled.blocked.message}</p>;
  else if (target === 'samsung' && compiled.cardData)
    card = (
      <SamsungCard data={compiled.cardData as Parameters<typeof SamsungCard>[0]['data']} testBand />
    );
  else if (target === 'google' && compiled.objectBody)
    card = (
      <GoogleCard
        type={compiled.type}
        classBody={compiled.classBody}
        objectBody={compiled.objectBody}
        testBand
      />
    );
  return (
    <div className="pg-wallet" data-face={face}>
      {card}
    </div>
  );
}

/** Paper: a static image for a visitor, the live sheet for a signed-in developer. */
export function PaperPane({
  source,
  image,
}: {
  source: PreviewSource | null;
  image: { src: string; width: number; height: number } | undefined;
}) {
  if (image)
    return (
      <img
        className="pg-paper-img"
        src={image.src}
        width={image.width}
        height={image.height}
        alt="The printed ticket, sample"
      />
    );
  return source ? (
    <Suspense fallback={<Skel ratio="210/297" />}>
      <LivePaper source={source} />
    </Suspense>
  ) : (
    <Skel ratio="210/297" />
  );
}
