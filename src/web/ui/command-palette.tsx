import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import type { LucideIcon } from 'lucide-react';
import { Search } from 'lucide-react';
import { DialogOverlay } from './dialog.tsx';

export interface CommandItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  hint?: string;
  keywords?: string[];
  /** Skip cmdk filtering (server-side results). */
  remote?: boolean;
  onSelect: () => void;
}

export interface CommandGroup {
  heading: string;
  items: readonly CommandItem[];
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: readonly CommandGroup[];
  query: string;
  onQueryChange: (query: string) => void;
  placeholder?: string;
}

export function CommandPalette({
  open,
  onOpenChange,
  groups,
  query,
  onQueryChange,
  placeholder = 'Search',
}: CommandPaletteProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogOverlay />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed top-[15vh] left-1/2 z-50 w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-surface-overlay shadow-elevation-3"
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <Command label={placeholder} loop>
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search aria-hidden className="size-4 text-fg-muted" />
              <Command.Input
                value={query}
                onValueChange={onQueryChange}
                placeholder={placeholder}
                aria-label={placeholder}
                className="h-11 w-full bg-transparent text-sm text-fg outline-hidden placeholder:text-fg-subtle"
              />
            </div>
            <Command.List className="max-h-80 overflow-auto p-1">
              <Command.Empty className="px-3 py-6 text-center text-sm text-fg-muted">
                No results
              </Command.Empty>
              {groups.map((group) =>
                group.items.length === 0 ? null : (
                  <Command.Group
                    key={group.heading}
                    heading={group.heading}
                    forceMount={group.items.every((i) => i.remote) || undefined}
                    className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-fg-muted"
                  >
                    {group.items.map((item) => (
                      <Command.Item
                        key={item.id}
                        value={`${group.heading}:${item.id}:${item.label}`}
                        keywords={item.keywords}
                        forceMount={item.remote || undefined}
                        onSelect={() => {
                          onOpenChange(false);
                          item.onSelect();
                        }}
                        className="flex min-h-9 cursor-pointer items-center gap-2 rounded-sm px-2 text-sm text-fg data-[selected=true]:bg-state-hover-tint data-[selected=true]:text-fg-strong [&_svg]:size-4 [&_svg]:text-fg-muted"
                      >
                        {item.icon ? <item.icon aria-hidden /> : null}
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        {item.hint ? (
                          <span className="text-xs text-fg-subtle">{item.hint}</span>
                        ) : null}
                      </Command.Item>
                    ))}
                  </Command.Group>
                ),
              )}
            </Command.List>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
