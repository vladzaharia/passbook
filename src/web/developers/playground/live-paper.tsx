import { useEffect, useMemo, useState } from 'react';
import { resolvePaper } from '@/passkit/template/paper.ts';
import { bestImage, imageSlots } from '@/passkit/template/paper-assets.ts';
import { paperContent } from '@/passkit/template/paper-content.ts';
import { withRegionSize } from '@/passkit/template/paper-region.ts';
import type { PassJson, TemplateManifest } from '@/passkit/types.ts';
import type { PreviewSource } from '../../channel-previews/types.ts';
import { localZone } from '../../lib/timezones.ts';
import { PAPER_CSS } from '../../paper/css.ts';
import { drawPaperCode, type PaperDrawing } from '../../paper/drawing.ts';
import { PaperTicket } from '../../paper/ticket.tsx';
import { usePaperCss } from '../../paper/use-paper-css.ts';
import { assetUrlMap } from '../../pass-card/assets.ts';
import { loadBarcodeEngine } from '../../pass-card/barcode-engine.ts';
import { Skel } from './skel.tsx';

/** Signed in, the sheet draws in the browser from the edited pass: the same PaperTicket the print page uses. */
export default function LivePaper({ source }: { source: PreviewSource }) {
  const inline = usePaperCss();
  const [drawing, setDrawing] = useState<PaperDrawing | undefined | null>(null);
  const manifest = useMemo(
    () => ({ ...source.manifest, sample: source.input }) as unknown as TemplateManifest,
    [source.manifest, source.input],
  );
  // No org here: the developer's own zone stands in, so a US developer previews on Letter.
  const zone = source.timeZone ?? localZone();
  const design = useMemo(
    () => withRegionSize(resolvePaper(manifest.paper), zone),
    [manifest, zone],
  );
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
        drawing={drawing}
        testBand
        assets={{ logo: logo ? urls[logo] : undefined, art: art ? urls[art] : undefined }}
      />
    </div>
  );
}
