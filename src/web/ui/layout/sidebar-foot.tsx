import { ArrowUpRight, Wrench } from 'lucide-react';
import { BRIDGE_COPY } from '@/shared/copy/workbench-bridge.ts';
import { useWorkbenchBridge } from '../../lib/workbench-bridge.ts';

/** The sidebar's foot: the org's Workbench, which opens in Test whatever mode admin is in. */
export function SidebarFoot() {
  const bridge = useWorkbenchBridge();
  if (!bridge) return null;
  return (
    <div className="shrink-0 border-t border-border p-2">
      <a
        href={bridge.href('home')}
        aria-label={BRIDGE_COPY.entryName}
        title={BRIDGE_COPY.opensTest}
        className="flex min-h-9 items-center gap-2.5 rounded-md px-3 text-sm text-fg-muted transition-[color,background-color] duration-(--wl-dur-hover) hover:bg-state-hover-tint hover:text-fg-strong pointer-coarse:min-h-11"
      >
        <Wrench aria-hidden className="size-4" />
        {BRIDGE_COPY.entry}
        <span className="ml-auto flex items-center gap-1.5 text-xs">
          {BRIDGE_COPY.test}
          <ArrowUpRight aria-hidden className="size-4" />
        </span>
      </a>
    </div>
  );
}
