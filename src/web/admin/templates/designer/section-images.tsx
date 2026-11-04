import { ImageUp, Trash2 } from 'lucide-react';
import { type DragEvent, useId, useRef, useState } from 'react';
import { cn } from '../../../lib/cn.ts';
import { Callout, IconButton } from '../../../ui/index.ts';
import { useDesigner } from './context.tsx';
import { isSlotImage, placeImage, previewAssetMap, slotHint } from './images.ts';
import { SLOT_LABEL, slotsOf } from './model.ts';

const MAX_BYTES = 5 * 1024 * 1024;

function SlotDrop({ slot }: { slot: string }) {
  const { doc, edit, assetBase } = useDesigner();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [soft, setSoft] = useState<string>();
  const current = doc.assets.find((a) => isSlotImage(a, slot));
  const url = current ? previewAssetMap([current], assetBase)[current.name] : undefined;
  const label = SLOT_LABEL[slot] ?? slot;

  async function take(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    if (file.size > MAX_BYTES) return setProblem(`${file.name} is larger than 5 MB.`);
    const placed = placeImage(slot, new Uint8Array(await file.arrayBuffer()));
    if (!placed.ok) {
      setSoft(undefined);
      return setProblem(placed.message);
    }
    setProblem(undefined);
    setSoft(placed.warning);
    edit({ op: 'image', slot, asset: placed.asset });
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void take(e.dataTransfer.files);
  };
  return (
    <li
      className="dz-slot"
      data-over={over || undefined}
      data-target={`images:${slot}`}
      tabIndex={-1}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag target; the labelled file input is the keyboard path */}
      <div
        className={cn('dz-drop', over && 'border-accent bg-accent-subtle')}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <div className="dz-thumb" aria-hidden>
          {url ? <img src={url} alt="" /> : <ImageUp className="size-5 text-fg-muted" />}
        </div>
        <div className="min-w-0 flex-1">
          <label htmlFor={id} className="block cursor-pointer text-sm font-medium text-fg-strong">
            {label}
            <span className="ml-1 font-normal text-fg-muted">
              {current
                ? `${current.name}${current.width ? `, ${current.width} × ${current.height} px` : ''}`
                : slot === 'icon'
                  ? 'required'
                  : 'none'}
            </span>
          </label>
          <p className="text-xs text-fg-muted">{slotHint(slot)}</p>
          <input
            ref={input}
            id={id}
            type="file"
            accept="image/png,.png"
            className="sr-only"
            onChange={(e) => {
              void take(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
        {current && slot !== 'icon' ? (
          <IconButton
            label={`Remove ${label.toLowerCase()}`}
            icon={<Trash2 aria-hidden />}
            variant="ghost"
            size="sm"
            onClick={() => edit({ op: 'image', slot, asset: null })}
          />
        ) : null}
      </div>
      {problem ? (
        <p role="alert" className="mt-1 text-xs text-danger">
          {problem}
        </p>
      ) : soft ? (
        <p className="mt-1 text-xs text-warning">{soft}</p>
      ) : null}
    </li>
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
