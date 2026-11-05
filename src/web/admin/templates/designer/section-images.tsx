import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge, Callout, IconButton } from '../../../ui/index.ts';
import { ImageSlotRow } from '../../passes/detail/image-slot-row.tsx';
import { slotNeeds } from '../../passes/detail/image-slots.ts';
import '../../passes/passes.css';
import { MAX_ASSET_BYTES, TOO_BIG } from '../../passes/png.ts';
import { useDesigner } from './context.tsx';
import { isSlotImage, placeImage, previewAssetMap } from './images.ts';
import { SLOT_LABEL, slotsOf } from './model.ts';

function SlotDrop({ slot }: { slot: string }) {
  const { doc, edit, assetBase } = useDesigner();
  const [problem, setProblem] = useState<string>();
  const [soft, setSoft] = useState<string>();
  const current = doc.assets.find((a) => isSlotImage(a, slot));
  const url = current ? previewAssetMap([current], assetBase)[current.name] : undefined;
  const label = SLOT_LABEL[slot] ?? slot;
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
  return (
    <ImageSlotRow
      target={`images:${slot}`}
      label={label}
      badge={slot === 'icon' ? <Badge>Required</Badge> : null}
      thumb={{ url: url ?? null }}
      ground={ground}
      detail={
        current
          ? `@${current.scale}x${current.width ? `: ${current.width} × ${current.height} px` : ''}`
          : undefined
      }
      needs={slotNeeds(slot)}
      error={problem}
      warning={soft}
      onFile={(f) => void take(f)}
      replaceLabel={`${current ? 'Replace' : 'Add'} ${label}`}
      trailing={
        current && slot !== 'icon' ? (
          <IconButton
            label={`Remove ${label.toLowerCase()}`}
            icon={<Trash2 aria-hidden />}
            variant="ghost"
            size="sm"
            onClick={() => edit({ op: 'image', slot, asset: null })}
          />
        ) : null
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
