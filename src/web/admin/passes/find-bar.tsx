import { Search, X } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useId, useMemo, useState } from 'react';
import type { InputField } from '@/shared/issuing/fields.ts';
import { cn } from '../../lib/cn.ts';
import { Select } from '../../ui/index.ts';
import {
  ANY_KEY,
  chipField,
  chipValue,
  type FindChip,
  MAX_FIND_CHIPS,
  type Suggestion,
  suggest,
  verbOf,
} from './find-query.ts';

const ANY = 'all';

function ChipView({
  chip,
  fields,
  onRemove,
}: {
  chip: FindChip;
  fields: readonly InputField[];
  onRemove: () => void;
}) {
  const field = chipField(chip, fields);
  const value = chipValue(chip, fields);
  return (
    <span className="wl-find-chip inline-flex max-w-full items-center gap-1 rounded-full bg-accent-subtle py-0.5 pr-0.5 pl-2.5 text-sm text-accent-fg">
      <span className="truncate">
        {field} {verbOf(chip.o)} <b className="font-semibold">{value}</b>
      </span>
      <button
        type="button"
        aria-label={`Remove ${field} ${verbOf(chip.o)} ${value}`}
        onClick={onRemove}
        className="relative grid size-6 shrink-0 place-items-center rounded-full hover:bg-accent/15 focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:size-8"
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </span>
  );
}

/**
 * One bar for free text and filter chips. Typing offers what the text could mean; Enter takes the
 * first (or the arrowed) offer and it becomes a chip. Backspace on an empty bar drops the last chip.
 */
export function FindBar({
  chips,
  fields,
  templates,
  templateId,
  onTemplate,
  onAdd,
  onRemove,
  extra,
}: {
  chips: readonly FindChip[];
  fields: readonly InputField[];
  templates: readonly { id: string; name: string }[];
  templateId: string | undefined;
  onTemplate: (id: string | undefined) => void;
  onAdd: (chip: FindChip) => void;
  onRemove: (index: number) => void;
  /** A control beside the bar, where the template select sits. */
  extra?: ReactNode;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const offers = useMemo(() => (open ? suggest(text, fields) : []), [open, text, fields]);
  const full = chips.length >= MAX_FIND_CHIPS;

  function take(s: Suggestion | undefined) {
    if (!s || full) return;
    onAdd(s.chip);
    setText('');
    setAt(0);
    setOpen(false);
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (offers.length === 0) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setAt((i) => (i + step + offers.length) % offers.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      take(offers[at]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    } else if (e.key === 'Backspace' && text === '' && chips.length > 0) {
      onRemove(chips.length - 1);
    }
  }

  return (
    <search className="relative mb-3 flex flex-wrap items-center gap-x-2 gap-y-1">
      <div
        className={cn(
          'flex min-h-9 min-w-0 flex-1 basis-72 flex-wrap items-center gap-1.5 rounded-md border border-border-strong bg-(--wl-field) px-2.5 py-1 wl-colors pointer-coarse:py-0',
          'focus-within:border-focus focus-within:outline-2 focus-within:outline-focus',
        )}
      >
        <Search aria-hidden className="size-4 shrink-0 text-fg-muted" />
        {chips.map((c, i) => (
          <ChipView
            key={`${c.k}:${c.o}:${c.v}`}
            chip={c}
            fields={fields}
            onRemove={() => onRemove(i)}
          />
        ))}
        <input
          type="text"
          role="combobox"
          aria-expanded={offers.length > 0}
          aria-controls={`${id}-list`}
          aria-activedescendant={offers.length ? `${id}-${at}` : undefined}
          aria-autocomplete="list"
          aria-label="Find passes"
          placeholder={chips.length ? '' : 'Name, member ID, email or plan'}
          maxLength={120}
          disabled={full}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            setAt(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKey}
          className="h-7 min-w-16 flex-1 pointer-coarse:h-11 bg-transparent text-sm text-fg outline-none placeholder:text-(--wl-placeholder) pointer-coarse:text-[max(16px,1rem)]"
        />
      </div>
      {templates.length > 1 ? (
        <Select
          aria-label="Template"
          value={templateId ?? ANY}
          onValueChange={(v) => onTemplate(v === ANY ? undefined : v)}
          options={[
            { value: ANY, label: 'All templates' },
            ...templates.map((t) => ({ value: t.id, label: t.name })),
          ]}
          className="w-auto min-w-36 max-w-56 max-sm:w-full max-sm:max-w-none"
        />
      ) : null}
      {extra}
      {offers.length > 0 ? (
        <div
          id={`${id}-list`}
          role="listbox"
          aria-label="Suggestions"
          className="wl-pop absolute top-full left-0 z-40 mt-1.5 w-full max-w-md overflow-hidden rounded-md border border-border bg-surface-overlay py-1 text-sm shadow-elevation-2"
        >
          {offers.map((s, i) => (
            <div
              key={s.id}
              tabIndex={-1}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === at}
              // Mouse down, not click: the input's blur would close the list first.
              onMouseDown={(e) => {
                e.preventDefault();
                take(s);
              }}
              onMouseEnter={() => setAt(i)}
              className={cn(
                'flex cursor-pointer items-center gap-1.5 px-3 py-2 pointer-coarse:py-3',
                i === at && 'bg-accent-subtle',
              )}
            >
              {s.chip.k === ANY_KEY ? (
                <Search aria-hidden className="size-4 shrink-0 text-fg-muted" />
              ) : null}
              <span className="truncate">
                {s.chip.k === ANY_KEY ? (
                  <>“{s.chip.v}” in any field</>
                ) : (
                  <>
                    <b className="font-semibold">{s.field}</b> {s.verb}{' '}
                    <b className="font-semibold text-accent-fg">{s.chip.v}</b>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </search>
  );
}
