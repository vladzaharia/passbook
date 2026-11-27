import { Wrench } from 'lucide-react';
import { BRIDGE_AREA, BRIDGE_COPY } from '@/shared/copy/workbench-bridge.ts';
import { SANDBOX_ONLY, WB_TOOLS, type WbPathOptions, type WbTool } from '@/shared/workbench.ts';
import type { CommandItem } from '../command-palette.tsx';

const PREFIX = 'workbench:';

/** "Open in Workbench: <area>" for each area, Test only (the caller passes nothing in Live). */
export function workbenchItems(
  href: (tool: WbTool, options?: WbPathOptions) => string,
  sandbox: boolean,
): CommandItem[] {
  return WB_TOOLS.filter((t) => sandbox || !SANDBOX_ONLY.has(t)).map((t) => ({
    id: `${PREFIX}${t}`,
    label: `${BRIDGE_COPY.open}: ${BRIDGE_AREA[t].title}`,
    icon: Wrench,
    hint: BRIDGE_COPY.test,
    onSelect: () => window.location.assign(href(t)),
  }));
}

/** Words an item answers to besides its label. */
export const workbenchWords = (item: CommandItem): string[] => [
  'workbench',
  ...(BRIDGE_AREA[item.id.slice(PREFIX.length) as WbTool]?.keywords ?? []),
];
