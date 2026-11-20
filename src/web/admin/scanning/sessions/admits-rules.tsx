import { Link } from '@tanstack/react-router';
import type { CheckInPolicy } from '@/shared/contracts/check-in.ts';
import type { EntryRule } from '@/shared/contracts/template-releases.ts';
import { Badge } from '@/web/ui/index.ts';
import { useEligibleTemplates } from '../scanner-api.ts';

const MODE = {
  single: 'One scan per pass',
  daily: 'Once a day',
  unlimited: 'Every visit',
} as const;
const PLAN = { always: 'always-on plan', timed: 'timed plan', guest: 'guest plan' } as const;
const ORDER = ['single', 'daily', 'unlimited'] as const;

/** A type's rule in plain words. */
export function ruleWords(rule: EntryRule): string {
  const from = rule.durationFrom === 'issued' ? 'issue' : 'first scan';
  const parts: string[] = [MODE[rule.mode]];
  if (rule.days === 1) parts.push(`all day from ${from}`);
  else if (rule.days) parts.push(`${rule.days} days from ${from}`);
  if (rule.durationMinutes) parts.push(`${rule.durationMinutes} min from ${from}`);
  for (const kind of rule.plans) parts.push(PLAN[kind]);
  return parts.join(' · ');
}

/** What the session's own cap does to a type, or null when it changes nothing. */
export function capNote(rule: EntryRule, cap: CheckInPolicy): string | null {
  const capMode = ORDER.find((m) => m === cap.mode);
  if (!capMode) return null;
  return ORDER.indexOf(capMode) < ORDER.indexOf(rule.mode)
    ? `Session cap: ${MODE[capMode].toLowerCase()}`
    : null;
}

/** Read-only: each admitted pass type with the rule its template sets. Passes can override it. */
export function AdmitsRules({
  orgId,
  templateIds,
  cap,
}: {
  orgId: string;
  templateIds: string[];
  cap: CheckInPolicy;
}) {
  const types = useEligibleTemplates(orgId || undefined, Boolean(orgId) && templateIds.length > 0);
  const items = (types.data?.pages.flatMap((p) => p.items) ?? []).filter((t) =>
    templateIds.includes(t.templateId),
  );
  if (!items.length) return null;
  return (
    <section aria-label="Rules by pass type" className="grid gap-2">
      <h3 className="text-sm font-medium text-fg">Rules</h3>
      <ul className="divide-y divide-border rounded-md border border-border text-sm">
        {items.map((t) => {
          const note = t.rule ? capNote(t.rule, cap) : null;
          return (
            <li key={t.templateId} className="grid gap-1 px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="font-medium">{t.name}</strong>
                <Link
                  to="/admin/o/$orgId/templates/$templateId/design"
                  params={{ orgId, templateId: t.templateId }}
                  className="text-xs text-accent-fg underline"
                >
                  Scan settings
                </Link>
              </div>
              <p className="text-fg-muted">{t.rule ? ruleWords(t.rule) : 'No check-in action'}</p>
              <div className="flex flex-wrap gap-2">
                {t.rule ? (
                  <Badge>
                    {t.rule.source === 'template' ? 'Template default' : 'Action setting'}
                  </Badge>
                ) : null}
                {note ? <Badge tone="warning">{note}</Badge> : null}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-fg-muted">A pass can override its type’s rule.</p>
    </section>
  );
}
