import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import type { LucideIcon } from 'lucide-react';
import { Search } from 'lucide-react';
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { ActiveIndicator } from './active-indicator.tsx';
import { LensArt } from './art/lens.tsx';
import { DialogOverlay } from './dialog.tsx';

export interface CommandItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  /** A 12 px colour chip (a pass's background colour). */
  swatch?: string;
  hint?: string;
  onSelect: () => void;
}

export interface CommandGroup {
  heading: string;
  /** Group glyph from the entity registry (shown in tests and screen-reader order only). */
  icon?: LucideIcon;
  items: readonly CommandItem[];
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Already filtered by the caller (cmdk filtering is off, so results never re-sort mid-typing). */
  groups: readonly CommandGroup[];
  query: string;
  onQueryChange: (query: string) => void;
  placeholder?: string;
  /** Rendered when no group has items and the query is not empty. */
  empty?: ReactNode;
}

/** Every word must appear in the label or keywords (no fuzzy matching: 'maya' must not find 'API keys'). */
export function matchLabel(label: string, search: string, keywords?: readonly string[]): boolean {
  const hay = `${label} ${(keywords ?? []).join(' ')}`.toLowerCase();
  return search
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

const ITEM =
  'relative flex min-h-9 cursor-pointer items-center gap-2 rounded-sm px-2 text-sm text-fg pointer-coarse:min-h-11 data-[selected=true]:text-fg-strong [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-muted';

/** A row for any palette group, including the caller's empty-state rows. */
export function PaletteItem({ item, close }: { item: CommandItem; close: () => void }) {
  return (
    <Command.Item
      value={item.id}
      onSelect={() => {
        close();
        item.onSelect();
      }}
      className={ITEM}
    >
      {item.icon ? <item.icon aria-hidden /> : null}
      {item.swatch ? (
        <span
          aria-hidden
          style={{ background: item.swatch } as CSSProperties}
          className="size-3 shrink-0 rounded-[3px] border border-border"
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.hint ? (
        <span className="max-w-[45%] truncate text-xs text-fg-muted">{item.hint}</span>
      ) : null}
    </Command.Item>
  );
}

export function CommandPalette({
  open,
  onOpenChange,
  groups,
  query,
  onQueryChange,
  placeholder = 'Search',
  empty,
}: CommandPaletteProps) {
  const close = () => onOpenChange(false);
  const nothing = groups.every((g) => g.items.length === 0);
  // The first result stays selected as results arrive (server groups land after local ones),
  // until the person moves the selection themselves.
  const ids = groups.flatMap((g) => g.items.map((i) => i.id));
  const first = ids[0] ?? '';
  const resultKey = ids.join('|');
  const [selected, setSelected] = useState(first);
  const moved = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query resets the person's pick
  useEffect(() => {
    moved.current = false;
  }, [query]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-pick only when the results change
  useEffect(() => {
    if (!moved.current) setSelected(first);
  }, [resultKey]);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogOverlay />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="wl-dialog fixed top-[12vh] left-1/2 z-50 flex max-h-[76vh] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-border bg-surface-overlay shadow-[var(--wl-edge),var(--pk-elevation-3)] max-sm:top-[calc(env(safe-area-inset-top)+0.75rem)]"
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <Command
            label={placeholder}
            loop
            shouldFilter={false}
            value={selected}
            onValueChange={setSelected}
            onKeyDown={(e) => {
              if (/^(ArrowUp|ArrowDown|Home|End|PageUp|PageDown)$/.test(e.key))
                moved.current = true;
            }}
            onPointerMove={() => {
              moved.current = true;
            }}
            className="flex min-h-0 flex-col"
          >
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search aria-hidden className="size-4 text-fg-muted" />
              <Command.Input
                value={query}
                onValueChange={onQueryChange}
                placeholder={placeholder}
                aria-label={placeholder}
                className="h-11 w-full bg-transparent text-sm text-fg outline-hidden placeholder:text-fg-subtle pointer-coarse:text-base"
              />
            </div>
            <Command.List className="min-h-0 flex-1 overflow-auto p-1 [&_[cmdk-list-sizer]]:relative">
              <ActiveIndicator variant="list" />
              {nothing && query.trim() ? (
                <div data-art-host="" className="flex flex-col items-center gap-2 px-3 pt-4 pb-1">
                  <LensArt size="sm" />
                  <p className="text-sm text-fg-muted">No results</p>
                </div>
              ) : null}
              {nothing && query.trim() ? empty : null}
              {groups.map((group) =>
                group.items.length === 0 ? null : (
                  <Command.Group
                    key={group.heading}
                    heading={group.heading}
                    className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-fg-muted"
                  >
                    {group.items.map((item) => (
                      <PaletteItem key={item.id} item={item} close={close} />
                    ))}
                  </Command.Group>
                ),
              )}
            </Command.List>
            <div
              aria-hidden
              className="flex items-center gap-4 border-t border-border px-3 py-2 text-xs text-fg-muted max-sm:hidden"
            >
              <span className="flex items-center gap-1">
                <kbd className="rounded-sm border border-border px-1">↑</kbd>
                <kbd className="rounded-sm border border-border px-1">↓</kbd>
                move
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded-sm border border-border px-1">↵</kbd>
                open
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded-sm border border-border px-1">esc</kbd>
                close
              </span>
            </div>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
