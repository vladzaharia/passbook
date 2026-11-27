import { useNavigate } from '@tanstack/react-router';
import { ArrowUpRight, BookOpen, Keyboard } from 'lucide-react';
import { useEffect, useState } from 'react';
import { WB_AREA, WB_SHELL_COPY } from '@/shared/copy/workbench-shell.ts';
import { PATHS } from '@/shared/developers.ts';
import { wbPath } from '@/shared/workbench.ts';
import {
  type CommandGroup,
  type CommandItem,
  CommandPalette,
  matchLabel,
} from '../../ui/command-palette.tsx';
import type { WbContext } from '../host/contexts.ts';
import { keepTool } from '../host/contexts.ts';
import { adminLink } from '../host/tool-host.tsx';
import { GO_CHORD } from './keys.ts';
import { AREA_ICON } from './nav-model.ts';
import { useWbShell } from './shell-context.ts';

const DOCS: { label: string; href: string; keywords: string[] }[] = [
  { label: 'Guides', href: PATHS.guides, keywords: ['docs', 'how to'] },
  { label: 'API reference', href: PATHS.reference, keywords: ['docs', 'operations', 'endpoints'] },
  { label: 'Error codes', href: PATHS.errors, keywords: ['docs', 'problems'] },
  { label: 'Changelog', href: PATHS.changelog, keywords: ['docs', 'versions'] },
  { label: 'Status', href: PATHS.status, keywords: ['docs', 'uptime'] },
];

/**
 * The Workbench's ⌘K (design §2.4; the shell binds the key): the one kit `CommandPalette`, with the Workbench's sources:
 * areas in this context, the other contexts, the shell's actions and the docs (which open there).
 */
export function WorkbenchPalette({
  open,
  onOpenChange,
  singleKeys,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  singleKeys: boolean;
}) {
  const navigate = useNavigate();
  const { context, contexts, tool, openShortcuts } = useWbShell();
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const q = query.trim();
  // Words an item answers to beyond its label ("webhooks" finds Events).
  const words = new Map<string, readonly string[]>();
  const pick = (items: CommandItem[]) =>
    q ? items.filter((i) => matchLabel(i.label, q, words.get(i.id))) : items;

  const areas: CommandItem[] = context
    ? context.tools.map((t) => {
        words.set(`area:${t}`, WB_AREA[t].keywords);
        return {
          id: `area:${t}`,
          label: WB_AREA[t].title,
          icon: AREA_ICON[t],
          hint: singleKeys ? GO_CHORD[t] : undefined,
          onSelect: () => void navigate({ to: wbPath(context.orgId, t) }),
        };
      })
    : [];
  const switchTo = (target: WbContext) => () => {
    void navigate({ to: wbPath(target.orgId, keepTool(target, tool ?? 'home')) });
  };
  const others: CommandItem[] = contexts
    .filter((c) => c.orgId !== context?.orgId)
    .map((c) => ({
      id: `context:${c.orgId}`,
      label: c.name,
      hint: c.kind === 'sandbox' ? WB_SHELL_COPY.sandbox : WB_SHELL_COPY.organization,
      onSelect: switchTo(c),
    }));
  const actions: CommandItem[] = [
    { id: 'shortcuts', label: WB_SHELL_COPY.shortcuts, icon: Keyboard, onSelect: openShortcuts },
    ...(context
      ? [
          {
            id: 'admin',
            label: WB_SHELL_COPY.openInAdmin,
            icon: ArrowUpRight,
            onSelect: () => window.location.assign(adminLink(context.orgId)),
          },
        ]
      : []),
  ];
  // The docs are another document: a full load.
  const docs: CommandItem[] = DOCS.map((d) => {
    words.set(`docs:${d.href}`, d.keywords);
    return {
      id: `docs:${d.href}`,
      label: d.label,
      icon: BookOpen,
      hint: WB_SHELL_COPY.docs,
      onSelect: () => window.location.assign(d.href),
    };
  });
  const groups: CommandGroup[] = [
    { heading: 'Areas', items: pick(areas) },
    { heading: 'Contexts', items: pick(others) },
    { heading: 'Actions', items: pick(actions) },
    { heading: WB_SHELL_COPY.docs, items: pick(docs) },
  ].filter((g) => g.items.length > 0);

  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      groups={groups}
      query={query}
      onQueryChange={setQuery}
      placeholder={WB_SHELL_COPY.search}
    />
  );
}
