import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import type { PassFilter } from '@/shared/contracts/pass-selection.ts';
import { PASS_VIEWS_MAX, type PassView } from '@/shared/contracts/pass-views.ts';
import { cn } from '../../lib/cn.ts';
import { formatCount } from '../../lib/format.ts';
import { Button, Input, Popover, PopoverContent, PopoverTrigger, toast } from '../../ui/index.ts';

const count = (n: number | undefined) => (n === undefined ? '' : formatCount(n));

/**
 * Saved views as count chips: All, then each view, then "+" to save what is on screen. A view is
 * lit while the list's filter equals it.
 */
export function FindViews({
  views,
  counts,
  active,
  canSave,
  filter,
  onPick,
  onSave,
  onDelete,
}: {
  views: readonly PassView[];
  counts: ReadonlyMap<string, number | undefined>;
  /** The id of the view the list matches, `all` when unfiltered, undefined otherwise. */
  active: string | undefined;
  canSave: boolean;
  /** What is on screen: saved by "+". */
  filter: PassFilter;
  onPick: (view: PassView | null) => void;
  onSave: (name: string) => Promise<void>;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const blank = Object.keys(filter).length === 0;
  const chip = (id: string, label: string, view: PassView | null) => (
    <span key={id} className="inline-flex items-center">
      <button
        type="button"
        aria-pressed={active === id}
        onClick={() => onPick(view)}
        className={cn(
          'inline-flex h-8 items-center gap-2 rounded-full border px-3 text-sm font-medium wl-colors focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:h-11',
          active === id
            ? 'border-accent bg-accent-subtle text-accent-fg'
            : 'border-border-strong bg-(--wl-field) text-fg hover:border-fg-muted',
          view && canSave && 'rounded-r-none border-r-0',
        )}
      >
        {label}
        <span className="text-xs text-fg-muted tabular-nums">{count(counts.get(id))}</span>
      </button>
      {view && canSave ? (
        <button
          type="button"
          aria-label={`Delete view ${label}`}
          onClick={() => onDelete(id)}
          className={cn(
            'grid h-8 w-6 place-items-center rounded-r-full border border-l-0 text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:h-11 pointer-coarse:w-8',
            active === id
              ? 'border-accent bg-accent-subtle'
              : 'border-border-strong bg-(--wl-field)',
          )}
        >
          <X aria-hidden className="size-3.5" />
        </button>
      ) : null}
    </span>
  );

  async function save() {
    setBusy(true);
    try {
      await onSave(name.trim());
      setName('');
      setOpen(false);
    } catch (error) {
      toast.error(error, 'Could not save the view');
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="m-0 mb-3 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
      <legend className="sr-only">Views</legend>
      {chip('all', 'All', null)}
      {views.map((v) => chip(v.id, v.name, v))}
      {canSave && views.length < PASS_VIEWS_MAX ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              aria-label="Save as view"
              disabled={blank}
              title={blank ? 'Filter the list first.' : undefined}
              className="size-8 rounded-full pointer-coarse:size-11"
            >
              <Plus aria-hidden />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="flex flex-col gap-3">
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) void save();
              }}
            >
              <Input
                aria-label="View name"
                placeholder="View name"
                maxLength={40}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
              <Button type="submit" loading={busy} disabled={!name.trim()}>
                Save view
              </Button>
            </form>
          </PopoverContent>
        </Popover>
      ) : null}
    </fieldset>
  );
}
