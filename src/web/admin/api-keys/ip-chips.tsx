import { X } from 'lucide-react';
import { useId } from 'react';
import { Badge, Input } from '@/web/ui/index.ts';
import { isIpOrCidr, splitIps } from './cidr.ts';

/** Allowed IPs as chips: Enter, comma, space or leaving the field adds what is typed. */
export function IpChips({
  value,
  onChange,
  draft,
  onDraft,
  required,
  error,
}: {
  value: readonly string[];
  onChange: (next: string[]) => void;
  draft: string;
  onDraft: (next: string) => void;
  required: boolean;
  error?: string | undefined;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  function commit(text: string) {
    const tokens = splitIps(text);
    if (tokens.length === 0) return onDraft('');
    if (tokens.some((t) => !isIpOrCidr(t))) return onDraft(text);
    onChange([...value, ...tokens.filter((t, i) => !value.includes(t) && tokens.indexOf(t) === i)]);
    onDraft('');
  }
  return (
    <div className="flex flex-col">
      <label htmlFor={id} className="mb-2 text-sm font-medium text-fg">
        {required ? 'Allowed IPs' : 'Allowed IPs (optional)'}
        {required ? (
          <span aria-hidden className="ml-0.5 text-danger">
            *
          </span>
        ) : null}
      </label>
      <Input
        id={id}
        autoComplete="off"
        placeholder="203.0.113.0/24"
        value={draft}
        aria-invalid={error ? true : undefined}
        aria-required={required || undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(e) => {
          const next = e.target.value;
          if (/[\s,]$/.test(next) && splitIps(next).every(isIpOrCidr)) commit(next);
          else onDraft(next);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && draft.trim()) {
            e.preventDefault();
            commit(draft);
          }
          if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => draft.trim() && commit(draft)}
      />
      {error ? (
        <p id={errorId} className="mt-1 text-xs text-danger">
          {error}
        </p>
      ) : null}
      {value.length ? (
        <ul aria-label="Allowed IPs" className="mt-3 flex flex-wrap gap-2">
          {value.map((ip) => (
            <li key={ip}>
              <Badge className="gap-1.5 pr-1 font-mono">
                {ip}
                <button
                  type="button"
                  aria-label={`Remove ${ip}`}
                  className="inline-flex size-5 items-center justify-center rounded-full text-fg-muted wl-colors hover:bg-state-hover-tint hover:text-fg-strong pointer-coarse:size-8"
                  onClick={() => onChange(value.filter((x) => x !== ip))}
                >
                  <X aria-hidden />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
