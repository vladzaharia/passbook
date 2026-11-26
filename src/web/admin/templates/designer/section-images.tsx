import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { TEMPLATE_BRAND_COPY } from '@/shared/copy/template-brand.ts';
import { Badge, Button, Callout, IconButton } from '../../../ui/index.ts';
import { SourceTag } from '../../brand/source-tag.tsx';
import { ImageSlotRow } from '../../passes/detail/image-slot-row.tsx';
import { slotNeeds } from '../../passes/detail/image-slots.ts';
import '../../passes/passes.css';
import { MAX_ASSET_BYTES, TOO_BIG } from '../../passes/png.ts';
import { useLoadedUrl } from './assets.ts';
import { useDesigner } from './context.tsx';
import { isSlotImage, placeImage, previewAssetMap } from './images.ts';
import { SLOT_LABEL, slotsOf } from './model.ts';
import { ownParts } from './ops-brand.ts';
import { isBrandSlot, useOrgBrand } from './org-brand.ts';

const COPY = TEMPLATE_BRAND_COPY.designer;

const STAMP_STRIP_NEEDS =
  'needs 750 × 288 px (@2x) and 1125 × 432 px (@3x); stamps are drawn on it';

function SlotDrop({ slot }: { slot: string }) {
  const { doc, edit, assetBase, orgId, readOnly } = useDesigner();
  const org = useOrgBrand(orgId);
  const part = isBrandSlot(slot) ? slot : null;
  const orgImage = part ? org[part] : null;
  const own = part !== null && ownParts(doc).includes(part);
  const [problem, setProblem] = useState<string>();
  const [soft, setSoft] = useState<string>();
  const current = doc.assets.find((a) => isSlotImage(a, slot));
  const url = useLoadedUrl(
    current ? previewAssetMap([current], assetBase)[current.name] : undefined,
  );
  // With stamps the strip is the background they are drawn on.
  const behindStamps = slot === 'strip' && doc.manifest.stamps !== undefined;
  const label = behindStamps ? 'Strip background' : (SLOT_LABEL[slot] ?? slot);
  const ground =
    typeof doc.passJson.backgroundColor === 'string' ? doc.passJson.backgroundColor : undefined;

  async function take(file: File) {
    if (file.size > MAX_ASSET_BYTES) return setProblem(TOO_BIG);
    const placed = placeImage(slot, new Uint8Array(await file.arrayBuffer()));
    if (!placed.ok) {
      setSoft(undefined);
      return setProblem(placed.message);
    }
    setProblem(undefined);
    setSoft(placed.warning);
    edit({ op: 'image', slot, asset: placed.asset });
  }
  // The organization's image wins until the template asks to keep its own.
  if (part && orgImage && !own)
    return (
      <ImageSlotRow
        target={`images:${slot}`}
        label={label}
        badge={<SourceTag source="org" label={COPY.fromOrg} />}
        thumb={{ url: orgImage.url }}
        ground={ground}
        needs={slotNeeds(slot)}
        onFile={() => undefined}
        disabled
        action="Replace"
        trailing={
          <Button
            variant="outline"
            size="sm"
            disabled={readOnly}
            onClick={() => edit({ op: 'brand', part, own: true })}
          >
            {COPY.override}
          </Button>
        }
      />
    );
  return (
    <ImageSlotRow
      target={`images:${slot}`}
      label={label}
      badge={
        part && orgImage ? (
          <SourceTag source="template" label={COPY.own} />
        ) : slot === 'icon' ? (
          <Badge>Required</Badge>
        ) : null
      }
      thumb={{ url: url ?? null }}
      ground={ground}
      detail={
        current
          ? `@${current.scale}x${current.width ? `: ${current.width} × ${current.height} px` : ''}`
          : undefined
      }
      needs={behindStamps ? STAMP_STRIP_NEEDS : slotNeeds(slot)}
      error={problem}
      warning={soft}
      onFile={(f) => void take(f)}
      action={current ? 'Replace' : 'Add'}
      trailing={
        <>
          {part && orgImage ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={readOnly}
              onClick={() => edit({ op: 'brand', part, own: false })}
            >
              {COPY.useOrg}
            </Button>
          ) : null}
          {current && slot !== 'icon' ? (
            <IconButton
              label={`Remove ${label.toLowerCase()}`}
              icon={<Trash2 aria-hidden />}
              variant="ghost"
              size="sm"
              onClick={() => edit({ op: 'image', slot, asset: null })}
            />
          ) : null}
        </>
      }
    />
  );
}

export function ImagesSection() {
  const { doc } = useDesigner();
  const slots = slotsOf(doc.passJson, doc.assets);
  const unused = doc.assets.filter((a) => a.slot in SLOT_LABEL && !slots.includes(a.slot));
  return (
    <div className="grid gap-3">
      <ul className="grid gap-2" aria-label="Image slots">
        {slots.map((slot) => (
          <SlotDrop key={slot} slot={slot} />
        ))}
      </ul>
      {unused.length > 0 ? (
        <Callout tone="info">
          {unused.map((a) => a.name).join(', ')} {unused.length === 1 ? 'is' : 'are'} not used by
          this style and will be left out.
        </Callout>
      ) : null}
    </div>
  );
}
