import { useEffect, useMemo, useState } from 'react';
import { resolvePaper } from '@/passkit/template/paper.ts';
import { bestImage, imageSlots } from '@/passkit/template/paper-assets.ts';
import { paperContent } from '@/passkit/template/paper-content.ts';
import type { PassJson, TemplateManifest } from '@/passkit/types.ts';
import { normalize } from '@/shared/pass-view/index.ts';
import type { PreviewSource } from '../../channel-previews/types.ts';
import type { WalletPreviews } from '../../channel-previews/use-wallet-previews.ts';
import { PAPER_CSS } from '../../paper/css.ts';
import { drawPaperCode, type PaperDrawing } from '../../paper/drawing.ts';
import { PaperTicket } from '../../paper/ticket.tsx';
import { usePaperCss } from '../../paper/use-paper-css.ts';
import { assetUrlMap } from '../../pass-card/assets.ts';
import { loadBarcodeEngine } from '../../pass-card/barcode-engine.ts';
import { PassCardStage } from '../../pass-card/index.tsx';
import { GoogleCard } from '../../wallet-previews/google/google-card.tsx';
import { SamsungCard } from '../../wallet-previews/samsung/samsung-card.tsx';
import type { Face } from './hash.ts';

export function Skel({ ratio }: { ratio: string }) {
  return (
    <div
      className="pg-skel"
      style={{ aspectRatio: ratio }}
      role="status"
      aria-label="Loading preview"
    />
  );
}

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

/** Signed in, the sheet draws in the browser from the edited pass: the same PaperTicket the print page uses. */
function LivePaper({ source }: { source: PreviewSource }) {
  const inline = usePaperCss();
  const [drawing, setDrawing] = useState<PaperDrawing | undefined | null>(null);
  const manifest = useMemo(
    () => ({ ...source.manifest, sample: source.input }) as unknown as TemplateManifest,
    [source.manifest, source.input],
  );
  const design = useMemo(() => resolvePaper(manifest.paper), [manifest]);
  useEffect(() => {
    let live = true;
    loadBarcodeEngine().then(
      (toSvg) =>
        live && setDrawing(drawPaperCode(toSvg, design.barcode, 'PSAMPLEABCDEFGHIJKLMNOPQRST')),
      () => live && setDrawing(undefined),
    );
    return () => {
      live = false;
    };
  }, [design.barcode]);
  const content = useMemo(() => {
    try {
      return paperContent({
        passJson: source.passJson as unknown as PassJson,
        manifest,
        personalization: source.input,
        design,
        holderName: 'Sample holder',
        images: imageSlots(source.assets),
      });
    } catch {
      return null;
    }
  }, [source, manifest, design]);
  if (!content)
    return (
      <p role="alert" className="pg-bad">
        This ticket cannot be previewed.
      </p>
    );
  if (drawing === null) return <Skel ratio="210/297" />;
  const urls = assetUrlMap(source.assetBaseUrl, source.assetNames);
  const logo = bestImage(source.assets, 'logo');
  const art = content.art ? bestImage(source.assets, content.art) : undefined;
  return (
    <div className="pg-paper">
      {inline ? <style>{PAPER_CSS}</style> : null}
      <PaperTicket
        content={content}
        design={design}
        code="PSAMPLEABCDEFGHIJKLMNOPQRST"
        mark="full"
        drawing={drawing}
        testBand
        assets={{ logo: logo ? urls[logo] : undefined, art: art ? urls[art] : undefined }}
      />
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
  return source ? <LivePaper source={source} /> : <Skel ratio="210/297" />;
}
