import { Minus, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useToolApi } from '../../../lib/tool-api.tsx';
import { Badge, Button, Callout, IconButton, SwitchRow, toast } from '../../../ui/index.ts';
import { ImageSlotRow } from '../../passes/detail/image-slot-row.tsx';
import '../../passes/passes.css';
import { MAX_ASSET_BYTES, TOO_BIG } from '../../passes/png.ts';
import { fetchBlueprintArt } from './blueprint-art.ts';
import { useDesigner } from './context.tsx';
import { PickEdit } from './controls.tsx';
import { previewAssetMap } from './images.ts';
import { placeStampArt } from './stamp-art.ts';
import { StampGrid } from './stamp-grid.tsx';
import {
  ART_HINT,
  ART_SLOTS,
  type ArtSlot,
  countInputs,
  GOAL_MAX,
  GOAL_MIN,
  gridNote,
  holdsNote,
  readStamps,
} from './stamps.ts';

function ArtDrop({ slot }: { slot: (typeof ART_SLOTS)[number] }) {
  const { doc, edit, assetBase } = useDesigner();
  const [problem, setProblem] = useState<string>();
  const [soft, setSoft] = useState<string>();
  const current = doc.assets.find((a) => a.name === slot.file);
  const url = current ? previewAssetMap([current], assetBase)[current.name] : undefined;
  const ground =
    typeof doc.passJson.backgroundColor === 'string' ? doc.passJson.backgroundColor : undefined;
  async function take(file: File) {
    if (file.size > MAX_ASSET_BYTES) return setProblem(TOO_BIG);
    const placed = placeStampArt(slot.file, new Uint8Array(await file.arrayBuffer()));
    setSoft(placed.ok ? placed.warning : undefined);
    setProblem(placed.ok ? undefined : placed.message);
    if (placed.ok) edit({ op: 'stamps-art', slot: slot.slot, asset: placed.asset });
  }
  return (
    <ImageSlotRow
      target={`stamps:${slot.slot}`}
      label={slot.label}
      badge={slot.optional ? <Badge>Optional</Badge> : <Badge>Required</Badge>}
      thumb={{ url: url ?? null }}
      ground={ground}
      detail={current?.width ? `${current.width} × ${current.height} px` : undefined}
      needs="square PNG"
      error={problem}
      warning={soft}
      onFile={(f) => void take(f)}
      action={current ? 'Replace' : 'Add'}
      trailing={
        current && slot.optional ? (
          <IconButton
            label={`Remove ${slot.label.toLowerCase()}`}
            icon={<Trash2 aria-hidden />}
            variant="ghost"
            size="sm"
            onClick={() => edit({ op: 'stamps-art', slot: slot.slot as ArtSlot, asset: null })}
          />
        ) : null
      }
    />
  );
}

function GoalStepper({ goal }: { goal: number }) {
  const { edit } = useDesigner();
  const set = (g: number) => edit({ op: 'stamps-goal', goal: g });
  return (
    <fieldset className="m-0 grid min-w-0 gap-1.5 border-0 p-0">
      <legend className="mb-1.5 p-0 text-sm font-medium text-fg-strong">Goal</legend>
      <div className="flex items-center gap-2">
        <IconButton
          label="Fewer stamps"
          icon={<Minus aria-hidden />}
          variant="outline"
          disabled={goal <= GOAL_MIN}
          onClick={() => set(goal - 1)}
        />
        <output
          key={goal}
          aria-live="polite"
          className="dz-goal min-w-10 text-center text-xl font-semibold tabular-nums text-fg-strong"
        >
          {goal}
        </output>
        <IconButton
          label="More stamps"
          icon={<Plus aria-hidden />}
          variant="outline"
          disabled={goal >= GOAL_MAX}
          onClick={() => set(goal + 1)}
        />
      </div>
      <p className="text-xs text-fg-muted">
        {GOAL_MIN} to {GOAL_MAX} stamps.
      </p>
    </fieldset>
  );
}

export function StampsSection() {
  const { doc, edit, stamps, readOnly, orgId } = useDesigner();
  const api = useToolApi();
  const view = readStamps(doc);
  const [busy, setBusy] = useState(false);

  async function loadArt(add: boolean) {
    setBusy(true);
    try {
      const art = await fetchBlueprintArt(api, orgId);
      if (add) edit({ op: 'stamps-add', art });
      else
        for (const { slot } of ART_SLOTS)
          if (art[slot]) edit({ op: 'stamps-art', slot, asset: art[slot] ?? null }, 'stamps-art');
    } catch (cause) {
      toast.error(cause, 'Could not load the art');
    } finally {
      setBusy(false);
    }
  }

  if (!view)
    return (
      <div className="grid gap-3">
        <div>
          <Button loading={busy} disabled={readOnly} onClick={() => void loadArt(true)}>
            Add stamps
          </Button>
        </div>
      </div>
    );

  const count = Math.min(stamps.count, view.goal);
  return (
    <div className="grid gap-5">
      <GoalStepper goal={view.goal} />
      <div className="grid gap-2">
        <StampGrid goal={view.goal} count={count} className="max-w-sm" />
        <p className="text-xs text-fg-muted">{gridNote(view.goal)}</p>
        <div className="grid gap-1">
          <label
            htmlFor="dz-stamps-preview"
            className="flex justify-between text-sm text-fg-strong"
          >
            <span>Preview</span>
            <output className="tabular-nums text-fg-muted">
              {count} of {view.goal}
            </output>
          </label>
          <input
            id="dz-stamps-preview"
            type="range"
            min={0}
            max={view.goal}
            step={1}
            value={count}
            onChange={(e) => stamps.setCount(Number(e.target.value))}
            className="dz-range"
          />
        </div>
      </div>
      <PickEdit
        label="Count from"
        value={view.input}
        options={countInputs(doc.manifest)}
        help={holdsNote(view.goal)}
        onPick={(input) => edit({ op: 'stamps-input', input })}
      />
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-fg-strong">Stamp art</h3>
          <Button
            variant="ghost"
            size="sm"
            iconStart={<RotateCcw aria-hidden />}
            loading={busy}
            disabled={readOnly}
            onClick={() => void loadArt(false)}
          >
            Use blueprint art
          </Button>
        </div>
        <ul className="grid gap-2" aria-label="Stamp art">
          {ART_SLOTS.map((slot) => (
            <ArtDrop key={slot.slot} slot={slot} />
          ))}
        </ul>
        <p className="text-xs text-fg-muted">{ART_HINT}</p>
      </div>
      <SwitchRow
        label="Tilt stamps"
        checked={view.tilt}
        onCheckedChange={(tilt) => edit({ op: 'stamps-set', patch: { tilt } })}
      />
      {doc.assets.some((a) => a.name === 'strip@2x.png') ? null : (
        <Callout tone="info">No strip background: the pass colour shows behind the stamps.</Callout>
      )}
    </div>
  );
}
