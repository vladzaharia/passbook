import { ArrowRight } from 'lucide-react';
import { ORG_FIELDS } from '../settings/fields-org.ts';
import { PLATFORM_FIELDS } from '../settings/fields-platform.ts';
import { redact } from './redact.ts';

const LABEL = new Map<string, string>(
  [...PLATFORM_FIELDS, ...ORG_FIELDS].map((f) => [f.key, f.label]),
);

export interface Change {
  key: string;
  label: string;
  from: string;
  to: string;
}

const show = (v: unknown): string => {
  if (v === null || v === undefined) return 'Default';
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if (typeof v === 'string') return v === '' ? 'Empty' : v;
  return String(v);
};

/** `{ changes: { key: { from, to } } }` of a settings entry, redacted; undefined for any other detail. */
export function settingChanges(detail: unknown): Change[] | undefined {
  if (typeof detail !== 'object' || detail === null) return undefined;
  const changes = (redact(detail) as { changes?: unknown }).changes;
  if (typeof changes !== 'object' || changes === null) return undefined;
  // The platform log keeps `{ key: { from, to } }`; an organization's reads `[{ label: key, from, to }]`.
  const pairs: [string, unknown][] = Array.isArray(changes)
    ? changes.flatMap((c: { label?: unknown; from?: unknown; to?: unknown }) =>
        typeof c?.label === 'string'
          ? [[c.label, { from: c.from, to: c.to }] as [string, unknown]]
          : [],
      )
    : Object.entries(changes);
  const list = pairs.map(([key, v]) => {
    const pair =
      typeof v === 'object' && v !== null ? (v as { from?: unknown; to?: unknown }) : null;
    return {
      key,
      label: LABEL.get(key) ?? key,
      from: pair ? show(pair.from) : show(v),
      to: pair ? show(pair.to) : show(v),
    };
  });
  return list.length > 0 ? list : undefined;
}

/** What changed: the setting, its old value, then its new one. */
export function ChangesList({ changes }: { changes: readonly Change[] }) {
  return (
    <ul aria-label="What changed" className="flex flex-col divide-y divide-border text-sm">
      {changes.map((c) => (
        <li key={c.key} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
          <span className="font-medium text-fg-strong">{c.label}</span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-fg-muted">
            <span className="break-all line-through decoration-fg-subtle">{c.from}</span>
            <ArrowRight aria-hidden className="size-3.5 shrink-0" />
            <span className="break-all text-fg-strong">{c.to}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
