import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  PAPER_SIZES,
  PAPER_SPECS,
  type PaperDesign,
  type PaperSize,
  resolvePaper,
  supportsCode128,
  withKind,
} from '@/passkit/template/paper.ts';
import { bestImage, imageSlots } from '@/passkit/template/paper-assets.ts';
import { paperContent } from '@/passkit/template/paper-content.ts';
import { withRegionSize } from '@/passkit/template/paper-region.ts';
import type { PassJson, TemplateManifest } from '@/passkit/types.ts';
import { TemplateChannelsResponseSchema } from '@/shared/contracts/channels.ts';
import { channelReason } from '@/shared/copy/channels.ts';
import { PRINT_COPY } from '@/shared/copy/print.ts';
import { api } from '../../../lib/api.ts';
import { PAPER_CSS } from '../../../paper/css.ts';
import { drawPaperCode, type PaperDrawing } from '../../../paper/drawing.ts';
import { PaperTicket } from '../../../paper/ticket.tsx';
import { usePaperCss } from '../../../paper/use-paper-css.ts';
import { loadBarcodeEngine } from '../../../pass-card/barcode-engine.ts';
import {
  Badge,
  Button,
  Callout,
  CheckboxField,
  EmptyState,
  FormField,
  Select,
  Skeleton,
} from '../../../ui/index.ts';
import { useBrandMark } from '../../brand/api.ts';
import { previewAssetMap } from './images.ts';
import type { DraftAsset } from './model.ts';
import type { PaperPatch } from './ops-paper.ts';
import { PaperEditor } from './paper-editor.tsx';

/** A code of the print code's shape, so the preview draws a real QR; never a real ticket's. */
const SAMPLE_CODE = 'PSAMPLEABCDEFGHIJKLMNOPQRST';

const SIZE_OPTIONS = PAPER_SIZES.map((size) => ({ value: size, label: PAPER_SPECS[size].label }));

/** The widest the sheet is drawn in the stage. */
const WIDTH: Record<PaperSize, string> = {
  a4: 'max-w-sm',
  letter: 'max-w-sm',
  half: 'max-w-lg',
  'half-letter': 'max-w-lg',
  cr80: 'max-w-md',
  cr80p: 'max-w-[14rem]',
  stub: 'max-w-xl',
  atb: 'max-w-2xl',
  a6: 'max-w-lg',
  dl: 'max-w-2xl',
};

/** The template's own paper state in this mode: platform, organization and template levels. */
function useTemplatePaper(templateId: string | undefined, orgId: string | undefined) {
  return useQuery({
    queryKey: ['admin', 'templates', 'paper', templateId, orgId],
    enabled: Boolean(templateId),
    retry: false,
    queryFn: ({ signal }) =>
      api.get(`/api/v1/templates/${templateId}/channels`, TemplateChannelsResponseSchema, {
        signal,
        query: { orgId },
      }),
  });
}

function useDrawing(design: PaperDesign): PaperDrawing | undefined | null {
  // null while the barcode encoder loads; undefined when the code cannot be drawn.
  const [drawing, setDrawing] = useState<PaperDrawing | undefined | null>(null);
  useEffect(() => {
    let live = true;
    loadBarcodeEngine()
      .then((toSvg) => live && setDrawing(drawPaperCode(toSvg, design.barcode, SAMPLE_CODE)))
      .catch(() => live && setDrawing(undefined));
    return () => {
      live = false;
    };
  }, [design.barcode]);
  return drawing;
}

/**
 * The Paper tab: the ticket as it prints, per size, from the draft's dry run and `paper` block. A
 * template whose paper is blocked (platform, organization, or never) shows the reason instead.
 */
export function PaperPreview({
  passJson,
  manifest,
  templateId,
  orgId,
  timeZone,
  assets = [],
  assetBase = '',
  onEdit,
  testBand,
}: {
  passJson: Record<string, unknown> | null | undefined;
  manifest: Record<string, unknown>;
  /** The draft's images and where saved ones are served: the sheet shows the logo and art. */
  assets?: readonly DraftAsset[] | undefined;
  assetBase?: string | undefined;
  templateId?: string | undefined;
  orgId?: string | undefined;
  /** The organization's `org.timeZone`: a layout with no block starts on Letter in the US and Canada. */
  timeZone?: string | undefined;
  /** Writes the block; absent when the draft is read-only. */
  onEdit?: ((patch: PaperPatch) => void) | undefined;
  /** A sandbox pass: the TEST PREVIEW band on every page. */
  testBand?: boolean | undefined;
}) {
  const inlineCss = usePaperCss();
  const channels = useTemplatePaper(templateId, orgId);
  const mark = useBrandMark(orgId);
  const saved = useMemo(
    () => withRegionSize(resolvePaper(manifest.paper), timeZone),
    [manifest.paper, timeZone],
  );
  const [picked, setPicked] = useState<PaperSize>(saved.size);
  const [grey, setGrey] = useState(false);
  const design = useMemo<PaperDesign>(
    () => ({ ...saved, size: picked, barcode: supportsCode128(picked) ? saved.barcode : 'qr' }),
    [saved, picked],
  );
  const drawing = useDrawing(design);
  // A sandbox pass previews every channel, so the organization's paper entitlement does not hide it.
  const paper = testBand ? undefined : channels.data?.effective.paper;
  // Off for the template is a default a pass can override; the others are not.
  const blocked = paper && !paper.on && paper.reason !== 'template_off' ? paper.reason : undefined;
  const content = useMemo(() => {
    if (!passJson) return null;
    try {
      return paperContent({
        passJson: passJson as unknown as PassJson,
        manifest: manifest as unknown as TemplateManifest,
        personalization: (manifest.sample as Record<string, never> | undefined) ?? {},
        design: saved,
        holderName: 'Sample holder',
        orgTimeZone: timeZone ?? null,
        images: imageSlots(assets),
      });
    } catch {
      return null;
    }
  }, [passJson, manifest, saved, assets, timeZone]);
  const urls = useMemo(() => previewAssetMap(assets, assetBase), [assets, assetBase]);
  const files = useMemo(() => {
    const url = (name: string | undefined) => (name ? urls[name] : undefined);
    return {
      logo: url(bestImage(assets, 'logo')),
      art: url(content?.art ? bestImage(assets, content.art) : undefined),
    };
  }, [assets, urls, content?.art]);

  return (
    <div className="flex w-full flex-col items-center gap-3" data-testid="designer-paper">
      {inlineCss ? <style>{PAPER_CSS}</style> : null}
      {blocked && paper ? (
        <EmptyState inline art="lock" title={channelReason('paper', blocked)} />
      ) : (
        <>
          {paper && !paper.on && paper.reason ? (
            <Callout tone="info" className="w-full">
              {channelReason('paper', paper.reason)}
            </Callout>
          ) : null}
          <FormField label={PRINT_COPY.sizeLabel}>
            {(c) => (
              <Select
                {...c}
                options={SIZE_OPTIONS}
                value={picked}
                onValueChange={(v) => {
                  const size = v as PaperSize;
                  setPicked(size);
                  if (onEdit && !saved.derived)
                    onEdit({
                      size,
                      ...(saved.barcode === 'code128' && !supportsCode128(size)
                        ? { barcode: 'qr' as const }
                        : {}),
                    });
                }}
                className="w-full sm:w-56"
              />
            )}
          </FormField>
          <CheckboxField
            label={PRINT_COPY.greyscale}
            checked={grey}
            onCheckedChange={(on) => setGrey(on === true)}
          />
          <div
            className={`w-full ${WIDTH[picked]}`}
            style={grey ? { filter: 'grayscale(1)' } : undefined}
          >
            {content && drawing !== null ? (
              <PaperTicket
                content={content}
                design={design}
                code={SAMPLE_CODE}
                mark={mark}
                drawing={drawing}
                assets={files}
                testBand={testBand}
              />
            ) : passJson && content === null ? (
              <p role="alert" className="text-sm text-danger">
                This ticket cannot be previewed. See the issues.
              </p>
            ) : (
              <Skeleton className="aspect-[210/297] w-full rounded-xl" />
            )}
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Badge tone="neutral">{PRINT_COPY.sample}</Badge>
            {saved.derived ? <Badge tone="neutral">{PRINT_COPY.derived}</Badge> : null}
            {(content ? withKind(saved, content.kind) : saved).holder ? null : (
              <Badge tone="warning">{PRINT_COPY.staffOnly}</Badge>
            )}
            {content?.ink === 'mono' && saved.ink !== 'mono' ? (
              <Badge tone="neutral">{PRINT_COPY.inkMonoNote}</Badge>
            ) : null}
          </div>
          {onEdit && saved.derived ? (
            <Button variant="outline" onClick={() => onEdit({ size: picked })}>
              {PRINT_COPY.editLayout}
            </Button>
          ) : null}
          {onEdit && !saved.derived ? (
            <PaperEditor design={saved} manifest={manifest} passJson={passJson} onEdit={onEdit} />
          ) : null}
        </>
      )}
    </div>
  );
}
