import { Search } from 'lucide-react';
import { useState } from 'react';
import { Checkbox, Input, Label } from '@/web/ui/index.ts';
import { AREA_LABEL } from './key-presets.ts';
import { SCOPE_LABEL } from './queries.ts';

const area = (scope: string) => {
  const key = scope.split(':')[0] ?? scope;
  return AREA_LABEL[key] ?? key;
};

/** Every scope the key may hold, by area, with a filter. The first box carries the group's error. */
export function ScopePicker({
  offered,
  value,
  onChange,
  error,
  note,
}: {
  offered: readonly string[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  error?: string | undefined;
  /** Scopes the last change of key kind removed, said once. */
  note?: string | undefined;
}) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const shown = offered.filter(
    (s) => !needle || s.includes(needle) || (SCOPE_LABEL[s] ?? '').toLowerCase().includes(needle),
  );
  const areas = [...new Set(shown.map(area))];
  return (
    <fieldset
      className="flex min-w-0 flex-col gap-2"
      aria-describedby={error ? 'scopes-error' : undefined}
    >
      <legend className="mb-2 flex w-full items-baseline justify-between gap-2 text-sm font-medium text-fg">
        <span>
          Scopes
          <span aria-hidden className="ml-0.5 text-danger">
            *
          </span>
        </span>
        <span className="text-xs font-normal text-fg-muted">{value.length} picked</span>
      </legend>
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-muted"
        />
        <Input
          type="search"
          aria-label="Filter scopes"
          autoComplete="off"
          placeholder="Filter"
          className="pl-9"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
        />
      </div>
      {note ? (
        <p role="status" className="text-xs text-fg-muted">
          {note}
        </p>
      ) : null}
      <div className="max-h-72 overflow-y-auto rounded-md border border-border-strong">
        {areas.length === 0 ? <p className="p-3 text-sm text-fg-muted">No scopes match.</p> : null}
        {areas.map((a) => (
          <section key={a} aria-label={a}>
            <h4 className="sticky top-0 z-10 border-b border-border bg-surface-sunken px-3 py-1.5 text-xs font-medium text-fg-muted">
              {a}
            </h4>
            <ul className="divide-y divide-border">
              {shown
                .filter((s) => area(s) === a)
                .map((s) => {
                  const id = `scope-${s.replace(':', '-')}`;
                  const flagged = Boolean(error) && s === offered[0];
                  return (
                    <li key={s} className="flex min-h-11 items-center gap-3 px-3 py-2">
                      <Checkbox
                        id={id}
                        aria-invalid={flagged || undefined}
                        aria-describedby={flagged ? 'scopes-error' : undefined}
                        checked={value.includes(s)}
                        onCheckedChange={(c) =>
                          onChange(c === true ? [...value, s] : value.filter((x) => x !== s))
                        }
                      />
                      <Label htmlFor={id} className="min-w-0 flex-1 font-normal">
                        {SCOPE_LABEL[s] ?? s}
                      </Label>
                      <code className="hidden shrink-0 font-mono text-xs text-fg-muted @md:block">
                        {s}
                      </code>
                    </li>
                  );
                })}
            </ul>
          </section>
        ))}
      </div>
      {error ? (
        <p id="scopes-error" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
