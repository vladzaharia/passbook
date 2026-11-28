import {
  Box,
  Inbox,
  KeyRound,
  LayoutGrid,
  List,
  type LucideIcon,
  Milestone,
  Radio,
  Sparkles,
  SquareTerminal,
  Ticket,
  Zap,
} from 'lucide-react';
import { WB_GROUPS, wbLabel } from '@/shared/copy/workbench-shell.ts';
import { WB_HOME, type WbTool } from '@/shared/workbench.ts';

/** One glyph per area (entity glyphs where one exists): the nav, the area button, the tool head's tile, the palette. */
export const AREA_ICON: Record<WbTool, LucideIcon> = {
  home: LayoutGrid,
  quickstart: Zap,
  design: Sparkles,
  passes: Ticket,
  console: SquareTerminal,
  logs: List,
  events: Radio,
  inbox: Inbox,
  activity: Milestone,
  keys: KeyRound,
  sandbox: Box,
};

export interface NavItem {
  tool: WbTool;
  label: string;
  icon: LucideIcon;
}

export interface NavGroup {
  id: 'top' | 'make' | 'watch' | 'setUp';
  /** Visible group heading; the top group has none. */
  label?: string;
  items: NavItem[];
}

const GROUPS: { id: NavGroup['id']; tools: WbTool[] }[] = [
  { id: 'top', tools: ['home', 'quickstart'] },
  { id: 'make', tools: ['design', 'passes', 'console'] },
  { id: 'watch', tools: ['logs', 'events', 'inbox', 'activity'] },
  { id: 'setUp', tools: ['keys', 'sandbox'] },
];

const item = (tool: WbTool): NavItem => ({
  tool,
  label: wbLabel(tool),
  icon: AREA_ICON[tool],
});

/**
 * The grouped nav for a context (design §1.4): make, then watch, then set up. Areas the context
 * lacks are dropped, never reordered. Quickstart leaves the top once done: the foot carries it.
 * Signed out, every area is listed (only Design and Quickstart are live links).
 */
export function navGroups(tools: readonly WbTool[], quickstartDone: boolean): NavGroup[] {
  const shown = new Set(tools);
  if (quickstartDone) shown.delete('quickstart');
  return GROUPS.map(({ id, tools: list }) => ({
    id,
    ...(id === 'top' ? {} : { label: WB_GROUPS[id as Exclude<NavGroup['id'], 'top'>] }),
    items: list.filter((t) => shown.has(t)).map(item),
  })).filter((g) => g.items.length > 0);
}

/** Areas a signed-out visitor may open: the Playground and Quickstart's first step. */
export const PUBLIC_AREAS: ReadonlySet<WbTool> = new Set(['design', 'quickstart']);

/** An area's path with no context: it resolves to the remembered one (routes/workbench/$tool). */
export const contextFreePath = (tool: WbTool): string =>
  tool === 'home' ? WB_HOME : `${WB_HOME}/${tool}`;
