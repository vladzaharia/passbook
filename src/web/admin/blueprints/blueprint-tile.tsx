import { Link } from '@tanstack/react-router';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn.ts';
import { Button, SegmentedControl, Skeleton } from '../../ui/index.ts';
import { PassPreview } from '../passes/pass-preview.tsx';
import { GALLERY_CARD } from '../templates/gallery.tsx';
import { useBlueprintPreview } from './api.ts';
import type { Entry } from './gallery-model.ts';
import { blueprintGlyph } from './glyph.ts';
import { blueprintVars } from './identity.ts';
import { BlueprintGlyph } from './identity.tsx';

/**
 * A blueprint: its pass on a drafting grid with a glow in its own colour, the glyph, the name, a
 * two-line description and Use. The whole tile is the link; Use sits above it. The pass lifts once
 * as the tile arrives and again on a click. An Access tile also holds its Member / Staff
 * choice, which swaps the blueprint the tile stands for.
 */
export function BlueprintTile({
  entry,
  index,
  rise,
  onUse,
}: {
  entry: Entry;
  index: number;
  /** First load: the stills deal in and the footer rises after them. */
  rise: boolean;
  onUse: (blueprint: Entry['variants'][number]['blueprint']) => void;
}) {
  const [pick, setPick] = useState(0);
  const b = (entry.variants[pick] ?? entry.variants[0])?.blueprint;
  const stage = useRef<HTMLDivElement>(null);
  const preview = useBlueprintPreview(b?.id ?? '');
  const first = useRef(true);
  const play = () => {
    const el = stage.current;
    if (!el) return;
    el.classList.remove('bp-play');
    void el.offsetWidth;
    el.classList.add('bp-play');
  };
  // A new choice lifts the new pass; the first render is the arrival, which has its own motion.
  // biome-ignore lint/correctness/useExhaustiveDependencies: replays on a change of choice only.
  useEffect(() => {
    if (first.current) first.current = false;
    else play();
  }, [pick]);
  if (!b) return null;
  const choices = entry.variants.length > 1;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the click only replays the tile's motion; the link and buttons are the keyboard controls.
    <li
      style={{ '--i': index, ...blueprintVars(preview.data?.passJson) } as CSSProperties}
      onClick={play}
      className={cn(
        GALLERY_CARD,
        '@container',
        'bp-tile wl-colors hover:border-border-strong has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-focus',
      )}
    >
      <div ref={stage} className="bp-stage">
        {/* Decorative: inert keeps the pass's own links out of the tab order and the a11y tree. */}
        <div
          inert
          aria-hidden
          className="bp-pass pointer-events-none w-full max-w-44 max-h-48 @max-[14rem]:max-h-32 @max-[14rem]:max-w-32 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]"
        >
          {preview.data ? (
            <PassPreview
              passJson={preview.data.passJson}
              assetBaseUrl={preview.data.assetBaseUrl}
              assetNames={preview.data.assetNames}
              still
              enter={rise}
            />
          ) : (
            <Skeleton className="mx-auto aspect-[320/420] w-full max-w-xs rounded-xl" />
          )}
        </div>
        {choices ? (
          <div className="absolute inset-x-2 bottom-2 z-10 flex justify-center">
            <SegmentedControl
              block
              label={`${entry.variants[0]?.blueprint.name} for`}
              value={String(pick)}
              onValueChange={(v) => setPick(Number(v))}
              options={entry.variants.map((v, i) => ({ value: String(i), label: v.label }))}
            />
          </div>
        ) : null}
      </div>
      <div
        className={cn(
          'flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-4 py-3 @max-[14rem]:px-3',
          rise && 'wl-rise [--wl-delay:calc(min(var(--i),6)*60ms+160ms)]',
        )}
      >
        <BlueprintGlyph icon={blueprintGlyph(b)} className="@max-[14rem]:hidden" />
        <div className="min-w-0 flex-1 @max-[14rem]:basis-full">
          <Link
            to="/admin/blueprints/$blueprintId"
            params={{ blueprintId: b.id }}
            className="block truncate text-sm font-medium text-fg-strong after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
          >
            {b.name}
          </Link>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="relative z-10 @max-[14rem]:w-full"
          aria-label={`Use ${b.name}`}
          onClick={() => onUse(b)}
        >
          Use
        </Button>
      </div>
    </li>
  );
}
