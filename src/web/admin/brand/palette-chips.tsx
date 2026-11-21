import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import { cn } from '@/web/lib/cn.ts';
import { type Palette, paletteOf } from './palette.ts';

const COPY = PASS_SETUP_COPY;

/** Palettes from the logo: the file just staged, else the saved logo fetched from its URL. */
export function useLogoPalettes(
  savedUrl: string | undefined,
  savedKey: string,
  staged: File | undefined,
) {
  const [fromFile, setFromFile] = useState<Palette[]>([]);
  useEffect(() => {
    let live = true;
    if (!staged) return setFromFile([]);
    paletteOf(staged).then(
      (p) => live && setFromFile(p),
      () => live && setFromFile([]),
    );
    return () => {
      live = false;
    };
  }, [staged]);
  const saved = useQuery({
    queryKey: ['brand', 'palette', savedKey],
    enabled: Boolean(savedUrl) && !staged,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    queryFn: async () => {
      const res = await fetch(savedUrl ?? '');
      if (!res.ok) return [];
      return paletteOf(await res.blob());
    },
  });
  return staged ? fromFile : (saved.data ?? []);
}

/** "From logo": palettes dealt in with a 60 ms stagger; the chosen one is ringed. */
export function PaletteChips({
  palettes,
  current,
  onPick,
  disabled,
}: {
  palettes: readonly Palette[];
  current: [string, string, string];
  onPick: (p: Palette) => void;
  disabled: boolean;
}) {
  if (palettes.length === 0) return null;
  const same = (p: Palette) =>
    p.swatches.every((c, i) => c.toLowerCase() === (current[i] ?? '').toLowerCase());
  return (
    <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
      <legend className="sr-only">{COPY.brand.fromLogo}</legend>
      <span aria-hidden className="text-xs text-fg-muted">
        {COPY.brand.fromLogo}
      </span>
      <div className="wl-deal flex flex-wrap gap-2">
        {palettes.map((p, i) => (
          <button
            key={p.id}
            type="button"
            disabled={disabled}
            aria-pressed={same(p)}
            style={{ '--i': i } as never}
            onClick={() => onPick(p)}
            className={cn(
              'inline-flex min-h-8 items-center gap-2 rounded-full border border-border-strong bg-surface-raised px-2.5 text-xs font-medium text-fg',
              'transition-[background-color,border-color] duration-(--wl-dur-hover) hover:bg-state-hover-tint',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50',
              'pointer-coarse:min-h-11',
              same(p) && 'border-accent ring-2 ring-accent',
            )}
          >
            <span aria-hidden className="inline-flex">
              {p.swatches.map((c, k) => (
                <span
                  key={c + String(k)}
                  className="-ml-1 size-4 rounded-full border border-border-strong first:ml-0"
                  style={{ background: c }}
                />
              ))}
            </span>
            {COPY.palettes[p.id]}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
