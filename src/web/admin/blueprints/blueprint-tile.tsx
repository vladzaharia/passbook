import { Link } from '@tanstack/react-router';
import type { CSSProperties } from 'react';
import type { TemplateSummaryDto } from '@/shared/contracts/templates.ts';
import { cn } from '../../lib/cn.ts';
import { Button, Skeleton } from '../../ui/index.ts';
import { PassPreview } from '../passes/pass-preview.tsx';
import { GALLERY_CARD } from '../templates/gallery.tsx';
import { useBlueprintPreview } from './api.ts';
import { blueprintGlyph } from './glyph.ts';
import { blueprintVars } from './identity.ts';
import { BlueprintGlyph } from './identity.tsx';

/**
 * A blueprint: its pass on a drafting grid with a glow in its own colour, the glyph, the name, a
 * two-line description and Use. The whole tile is the link; Use sits above it.
 */
export function BlueprintTile({
  blueprint: b,
  index,
  rise,
  onUse,
}: {
  blueprint: TemplateSummaryDto;
  index: number;
  /** First load: the stills deal in and the footer rises after them. */
  rise: boolean;
  onUse: () => void;
}) {
  const preview = useBlueprintPreview(b.id);
  return (
    <li
      style={{ '--i': index, ...blueprintVars(preview.data?.passJson) } as CSSProperties}
      className={cn(
        GALLERY_CARD,
        'bp-tile wl-colors hover:border-border-strong has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-focus',
      )}
    >
      <div className="bp-stage">
        {/* Decorative: inert keeps the pass's own links out of the tab order and the a11y tree. */}
        <div
          inert
          aria-hidden
          className="pointer-events-none w-full max-w-44 max-h-48 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]"
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
      </div>
      <div
        className={cn(
          'flex min-w-0 items-center gap-3 border-t border-border px-4 py-3',
          rise && 'wl-rise [animation-delay:calc(min(var(--i),6)*60ms+160ms)]',
        )}
      >
        <BlueprintGlyph icon={blueprintGlyph(b)} />
        <div className="min-w-0 flex-1">
          <Link
            to="/admin/blueprints/$blueprintId"
            params={{ blueprintId: b.id }}
            className="block truncate text-sm font-medium text-fg-strong after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
          >
            {b.name}
          </Link>
          {b.description ? (
            <p className="line-clamp-2 text-xs text-fg-muted">{b.description}</p>
          ) : null}
        </div>
        <Button
          size="sm"
          variant="outline"
          className="relative z-10"
          aria-label={`Use ${b.name}`}
          onClick={onUse}
        >
          Use
        </Button>
      </div>
    </li>
  );
}
