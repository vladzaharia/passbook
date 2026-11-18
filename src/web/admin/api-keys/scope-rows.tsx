import { ApiScopeSchema } from '@/shared/contracts/common.ts';
import { Checkbox, Label } from '@/web/ui/index.ts';
import { SCOPE_LABEL, useTerminals } from './queries.ts';

export const SCOPES = ApiScopeSchema.options;

export function ScopeRows({
  value,
  onChange,
  error,
  platform,
}: {
  value: readonly string[];
  onChange: (next: string[]) => void;
  error?: string | undefined;
  /** A platform key has no org to scan for. */
  platform: boolean;
}) {
  const offered = platform ? SCOPES.filter((s) => s !== 'scans:write') : SCOPES;
  return (
    <fieldset
      className="flex min-w-0 flex-col"
      aria-describedby={error ? 'scopes-error' : undefined}
    >
      <legend className="mb-2 text-sm font-medium text-fg">
        Scopes
        <span aria-hidden className="ml-0.5 text-danger">
          *
        </span>
      </legend>
      <ul className="divide-y divide-border rounded-md border border-border-strong">
        {offered.map((s, i) => {
          const id = `scope-${s.replace(':', '-')}`;
          // The first box carries the group's error, so a blocked submit focuses it once.
          const flagged = Boolean(error) && i === 0;
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
              <code className="shrink-0 font-mono text-xs text-fg-muted">{s}</code>
            </li>
          );
        })}
      </ul>
      {error ? (
        <p id="scopes-error" className="mt-1 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

/** The terminals a scan key may act as; fixed when the key is made. */
export function TerminalRows({
  orgId,
  value,
  onChange,
  error,
}: {
  orgId: string | null;
  value: readonly string[];
  onChange: (next: string[]) => void;
  error?: string | undefined;
}) {
  const terminals = useTerminals(orgId, true);
  return (
    <fieldset
      className="flex min-w-0 flex-col"
      aria-describedby={error ? 'terminals-error' : undefined}
    >
      <legend className="mb-2 text-sm font-medium text-fg">
        Terminals
        <span aria-hidden className="ml-0.5 text-danger">
          *
        </span>
      </legend>
      {terminals.isError ? (
        <p className="text-sm text-danger">Could not load terminals.</p>
      ) : terminals.data?.length === 0 ? (
        <p className="text-sm text-fg-muted">No terminals. Add one in Scanning.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border-strong">
          {(terminals.data ?? []).map((t, i) => {
            const id = `terminal-${t.id}`;
            const flagged = Boolean(error) && i === 0;
            return (
              <li key={t.id} className="flex min-h-11 items-center gap-3 px-3 py-2">
                <Checkbox
                  id={id}
                  aria-invalid={flagged || undefined}
                  aria-describedby={flagged ? 'terminals-error' : undefined}
                  checked={value.includes(t.id)}
                  onCheckedChange={(c) =>
                    onChange(c === true ? [...value, t.id] : value.filter((x) => x !== t.id))
                  }
                />
                <Label htmlFor={id} className="min-w-0 flex-1 font-normal">
                  {t.name}
                </Label>
              </li>
            );
          })}
        </ul>
      )}
      {error ? (
        <p id="terminals-error" className="mt-1 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
