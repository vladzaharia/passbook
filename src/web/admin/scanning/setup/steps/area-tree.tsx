import { Plus, X } from 'lucide-react';
import { cn } from '@/web/lib/cn.ts';
import { Button, IconButton, Input, Label, NumberField } from '@/web/ui/index.ts';
import { type AreaDraft, newArea } from '../draft.ts';

const MAX_AREAS = 8;
/** The kit's drawn radio (ui/radio-group.tsx), for a radio that sits inside a row. */
const RADIO = cn(
  'size-4 shrink-0 appearance-none rounded-full border border-border-strong bg-surface-raised wl-colors',
  'checked:border-state-checked-edge checked:bg-state-checked-fill checked:shadow-[inset_0_0_0_3px_var(--pk-surface-raised)]',
  'forced-colors:appearance-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
);
const MAX_DEPTH = 3;

/** Parents first, each with its depth, from the flat list. */
function ordered(areas: readonly AreaDraft[]): { area: AreaDraft; depth: number }[] {
  const out: { area: AreaDraft; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const area of areas) {
      if (area.inside !== parent || seen.has(area.ref)) continue;
      seen.add(area.ref);
      out.push({ area, depth });
      walk(area.ref, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/**
 * The areas as an indented tree: a radio marks the one this door is in, each has a max, and Add
 * inside nests a new one (three levels at most, eight areas in all).
 */
export function AreaTree({
  areas,
  doorArea,
  onChange,
}: {
  areas: AreaDraft[];
  doorArea: string | null;
  onChange: (areas: AreaDraft[], doorArea: string | null) => void;
}) {
  const rows = ordered(areas);
  const edit = (ref: string, patch: Partial<AreaDraft>) =>
    onChange(
      areas.map((a) => (a.ref === ref ? { ...a, ...patch } : a)),
      doorArea,
    );
  const remove = (ref: string) => {
    const gone = new Set([ref]);
    // Anything inside a removed area goes with it.
    for (let n = 0; n < MAX_DEPTH; n++)
      for (const a of areas) if (a.inside && gone.has(a.inside)) gone.add(a.ref);
    const rest = areas.filter((a) => !gone.has(a.ref));
    onChange(rest, doorArea && gone.has(doorArea) ? (rest[0]?.ref ?? null) : doorArea);
  };
  const add = (inside: string | null) => {
    const made = newArea(inside);
    onChange([...areas, made], doorArea ?? made.ref);
  };
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium text-fg-strong">Areas</legend>
      <ul className="grid gap-2">
        {rows.map(({ area, depth }) => (
          <li
            key={area.ref}
            style={{ marginInlineStart: `${depth * 1.5}rem` }}
            className={cn(
              'flex flex-wrap items-center gap-2 rounded-lg border bg-surface-raised p-2 pl-3',
              doorArea === area.ref ? 'border-accent' : 'border-border',
            )}
          >
            <input
              type="radio"
              name="door-area"
              aria-label={`This door is in ${area.name || 'this area'}`}
              checked={doorArea === area.ref}
              onChange={() => onChange(areas, area.ref)}
              className={RADIO}
            />
            <Label className="sr-only" htmlFor={`${area.ref}-name`}>
              Area name
            </Label>
            <Input
              id={`${area.ref}-name`}
              value={area.name}
              placeholder="Area"
              maxLength={40}
              onChange={(e) => edit(area.ref, { name: e.target.value })}
              className="min-w-0 flex-1 basis-32"
            />
            <NumberField
              aria-label={`Max inside ${area.name || 'this area'}`}
              placeholder="Max"
              min={1}
              value={area.max === '' ? null : Number(area.max)}
              onValueChange={(v) => edit(area.ref, { max: v === null ? '' : String(v) })}
            />
            {depth < MAX_DEPTH - 1 && areas.length < MAX_AREAS ? (
              <Button
                variant="ghost"
                size="sm"
                iconStart={<Plus aria-hidden />}
                onClick={() => add(area.ref)}
              >
                Add inside
              </Button>
            ) : null}
            <IconButton
              label={`Remove ${area.name || 'area'}`}
              icon={<X aria-hidden />}
              onClick={() => remove(area.ref)}
              disabled={areas.length === 1}
            />
          </li>
        ))}
      </ul>
      {areas.length < MAX_AREAS ? (
        <div>
          <Button
            variant="outline"
            size="sm"
            iconStart={<Plus aria-hidden />}
            onClick={() => add(null)}
          >
            Add area
          </Button>
        </div>
      ) : null}
    </fieldset>
  );
}
