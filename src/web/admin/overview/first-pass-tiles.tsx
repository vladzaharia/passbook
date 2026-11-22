import { Link } from '@tanstack/react-router';
import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import type { TemplateSummaryDto } from '@/shared/contracts/templates.ts';
import { cn } from '@/web/lib/cn.ts';
import { Skeleton } from '@/web/ui/index.ts';
import { useBlueprintPreview, useBlueprints } from '../blueprints/api.ts';
import { entriesOf } from '../blueprints/gallery-model.ts';
import { PassPreview } from '../passes/pass-preview.tsx';
import { FIRST_PASS_SLUGS } from './first-pass-state.ts';

const slugOf = (b: TemplateSummaryDto) => b.id.replace(/^.*starter-/, '');

/** Six blueprints: the usual starts first, then the gallery's order. */
export function pickTiles(items: readonly TemplateSummaryDto[]): TemplateSummaryDto[] {
  const all = entriesOf(items).map((e) => e.variants[0]?.blueprint);
  const list = all.filter((b): b is TemplateSummaryDto => b !== undefined);
  const first = FIRST_PASS_SLUGS.flatMap((s) => list.filter((b) => slugOf(b) === s));
  return [...first, ...list.filter((b) => !first.includes(b))].slice(0, 6);
}

function Tile({
  blueprint,
  orgId,
  index,
  onReady,
}: {
  blueprint: TemplateSummaryDto;
  orgId: string;
  index: number;
  onReady: () => void;
}) {
  const preview = useBlueprintPreview(blueprint.id);
  const told = useRef(false);
  const here = preview.data !== undefined || preview.isError;
  useEffect(() => {
    if (here && !told.current) {
      told.current = true;
      onReady();
    }
  }, [here, onReady]);
  return (
    <li style={{ '--i': index } as CSSProperties} className="fp-tile">
      <Link
        to="/admin/o/$orgId/blueprints/$blueprintId/use"
        params={{ orgId, blueprintId: blueprint.id }}
        className={cn(
          'fp-link group flex h-full flex-col items-center gap-2 rounded-lg border border-border bg-surface-sunken p-3 pb-2.5',
          'wl-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        )}
      >
        {/* Decorative: the link's name is the blueprint's. */}
        <span
          inert
          aria-hidden
          className="fp-still pointer-events-none block max-h-36 w-full max-w-28 overflow-hidden [mask-image:linear-gradient(to_bottom,black_72%,transparent)]"
        >
          {preview.data ? (
            <PassPreview
              passJson={preview.data.passJson}
              assetBaseUrl={preview.data.assetBaseUrl}
              assetNames={preview.data.assetNames}
              still
            />
          ) : (
            <Skeleton className="aspect-[320/420] w-full rounded-lg" />
          )}
        </span>
        <span className="text-center text-sm font-medium text-fg-strong">{blueprint.name}</span>
      </Link>
    </li>
  );
}

/** The tiles the first step deals in; each opens that blueprint's Make it yours page. */
export function FirstPassTiles({ orgId }: { orgId: string }) {
  const blueprints = useBlueprints();
  const tiles = useMemo(() => pickTiles(blueprints.data?.items ?? []), [blueprints.data]);
  if (blueprints.isPending)
    return (
      <div role="status" aria-busy className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <span className="sr-only">Loading blueprints</span>
        {[0, 1, 2, 3, 4, 5].map((k) => (
          <Skeleton key={k} className="h-44" />
        ))}
      </div>
    );
  return <Deal tiles={tiles} orgId={orgId} />;
}

/** The tiles hold their place unseen until their art is in (or 600 ms), then deal in together. */
function Deal({ tiles, orgId }: { tiles: TemplateSummaryDto[]; orgId: string }) {
  const [count, setCount] = useState(0);
  const [late, setLate] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setLate(true), 600);
    return () => clearTimeout(t);
  }, []);
  const [ready, setReady] = useState(false);
  const go = ready || late || count >= tiles.length;
  useEffect(() => {
    if (go) setReady(true);
  }, [go]);
  const onReady = useRef(() => setCount((n) => n + 1)).current;
  return (
    <ul
      className={cn(
        'm-0 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 xl:grid-cols-6',
        ready ? 'wl-deal' : 'invisible',
      )}
    >
      {tiles.map((b, i) => (
        <Tile key={b.id} blueprint={b} orgId={orgId} index={i} onReady={onReady} />
      ))}
    </ul>
  );
}
