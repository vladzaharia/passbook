import { ChevronDown } from 'lucide-react';
import { areaButtonTail, WB_SHELL_COPY, wbLabel } from '@/shared/copy/workbench-shell.ts';
import type { WbTool } from '@/shared/workbench.ts';
import { cn } from '../../lib/cn.ts';
import type { WbContext } from '../host/contexts.ts';
import { AREA_ICON } from './nav-model.ts';

/** The glyph tile: the area's icon on the accent tint (tool heads, the area button). */
export function GlyphTile({ tool, size = 'md' }: { tool: WbTool; size?: 'sm' | 'md' }) {
  const Icon = AREA_ICON[tool];
  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center rounded-md bg-accent-subtle text-accent-fg',
        size === 'sm' ? 'size-6.5 [&_svg]:size-3.5' : 'size-8 [&_svg]:size-4',
      )}
    >
      <Icon />
    </span>
  );
}

/** The Test tag after the area name below 1024: info in a sandbox (and with no context yet), warning in an org. */
export function TestTag({ context }: { context: WbContext | null }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded-full border px-1.5 text-[0.6875rem] font-medium',
        !context || context.kind === 'sandbox'
          ? 'border-info-border/50 bg-info-subtle text-info'
          : 'border-warning-border/50 bg-warning-subtle text-warning',
      )}
    >
      {WB_SHELL_COPY.test}
    </span>
  );
}

/**
 * Below 1024 the bar names the area (design §1.3): glyph tile, name, Test tag and a chevron, 44 px,
 * opening the nav sheet. The tile carries one danger dot when another area asks for attention, and
 * the name says where.
 */
export function AreaButton({
  tool,
  context,
  attentionIn,
  onOpen,
}: {
  tool: WbTool;
  context: WbContext | null;
  attentionIn: WbTool | null;
  onOpen: () => void;
}) {
  const area = wbLabel(tool);
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={onOpen}
      className="flex h-11 shrink-0 items-center gap-2 rounded-md pr-2 pl-1 text-[0.9375rem] font-semibold text-fg-strong wl-colors hover:bg-state-hover-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      <span className="relative">
        <GlyphTile tool={tool} size="sm" />
        {attentionIn ? <span className="wb-attn-dot" /> : null}
      </span>
      {/* Every area is one word, and the name never truncates below its first (design §7). */}
      <span className="whitespace-nowrap">{area}</span> <TestTag context={context} />
      {/* The name is the visible words plus these: "Logs Test, change area. Attention in Events". */}
      <span className="sr-only">
        {areaButtonTail(attentionIn ? wbLabel(attentionIn) : undefined)}
      </span>
      <ChevronDown aria-hidden className="size-4 shrink-0 text-fg-muted" />
    </button>
  );
}
