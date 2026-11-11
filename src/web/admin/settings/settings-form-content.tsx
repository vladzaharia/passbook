import type { z } from 'zod';
import type { SettingsListSchema } from '@/shared/contracts/settings.ts';
import { formatDay } from '@/web/lib/format.ts';
import { Callout, Card, CardHeader, SegmentedControl } from '@/web/ui/index.ts';
import type { Draft, SettingField } from './fields.ts';
import { PolicySummary } from './policy-summary.tsx';
import { SettingRow } from './setting-row.tsx';

type Entries = z.infer<typeof SettingsListSchema>['items'];

export const BASIC_KEYS: Record<string, true> = {
  'auth.magicLinkEnabled': true,
  'email.senderName': true,
};
const LEVELS = [
  { value: 'basic', label: 'Basic' },
  { value: 'advanced', label: 'Advanced' },
] as const;

/** Sections in field order; ungrouped fields share one untitled section. */
function sections(fields: readonly SettingField[]) {
  const out: { title: string | null; fields: SettingField[] }[] = [];
  for (const f of fields) {
    const title = f.group ?? null;
    const last = out[out.length - 1];
    if (last && last.title === title) last.fields.push(f);
    else out.push({ title, fields: [f] });
  }
  return out;
}

function displayValue(field: SettingField, value: unknown): string {
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (value === undefined || value === null || value === '') return 'Unavailable';
  return `${String(value)}${field.unit ? ` ${field.unit}` : ''}`;
}

export function SettingsFormContent({
  fields,
  entries,
  draft,
  initial,
  resets,
  errors,
  platform,
  level,
  setLevel,
  dirty,
  dirtyFields,
  advancedDirty,
  edit,
  reset,
}: {
  fields: readonly SettingField[];
  entries: Entries;
  draft: Draft;
  initial: Draft;
  resets: ReadonlySet<string>;
  errors: Record<string, string | undefined>;
  platform: boolean;
  level: 'basic' | 'advanced';
  setLevel: (level: 'basic' | 'advanced') => void;
  dirty: boolean;
  dirtyFields: readonly SettingField[];
  advancedDirty: number;
  edit: (key: string, value: string | boolean) => void;
  reset: (field: SettingField) => void;
}) {
  const renderSections = (subset: readonly SettingField[]) =>
    sections(subset).map((section) => {
      const rows = section.fields.map((field) => {
        const entry = entries.find((item) => item.key === field.key);
        const changedField = draft[field.key] !== initial[field.key] || resets.has(field.key);
        const magicHelp =
          field.key === 'auth.magicLinkEnabled'
            ? draft[field.key] === true
              ? changedField
                ? 'After saving, holders can sign in with an email link.'
                : 'Holders can sign in with an email link.'
              : changedField
                ? 'After saving, holders without Polaris ID will not be able to sign in.'
                : 'Email-link sign-in is off. Holders need Polaris ID.'
            : undefined;
        const source =
          entry && platform
            ? `${entry.updatedAt === null ? 'Platform default' : 'Saved platform setting'} · Effective: ${displayValue(field, entry.value)}${entry.default === undefined ? '' : ` · Default: ${displayValue(field, entry.default)}`}${entry.updatedAt === null ? '' : ` · Changed ${formatDay(entry.updatedAt)}${entry.updatedBy ? ` by ${entry.updatedBy}` : ''}`}${resets.has(field.key) ? ' · Reset pending' : changedField ? ' · Draft not applied' : ''}`
            : undefined;
        const canReset =
          platform &&
          entry?.default !== undefined &&
          !resets.has(field.key) &&
          (entry.updatedAt !== null || changedField);
        return (
          <SettingRow
            key={field.key}
            field={field}
            flat={!section.title}
            value={draft[field.key] ?? ''}
            error={errors[field.key]}
            help={magicHelp}
            meta={source}
            onReset={canReset ? () => reset(field) : undefined}
            onChange={(v) => edit(field.key, v)}
          />
        );
      });
      if (!section.title)
        return (
          <div key="flat" className="flex flex-col gap-4">
            {rows}
          </div>
        );
      return (
        <Card key={section.title}>
          <CardHeader title={section.title} />
          <div className="divide-y divide-border">{rows}</div>
        </Card>
      );
    });

  return (
    <>
      {platform ? (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <SegmentedControl
            label="Settings detail level"
            options={LEVELS}
            value={level}
            onValueChange={setLevel}
          />
          {dirty ? (
            <p className="text-sm text-fg-muted">
              {dirtyFields.length} unsaved {dirtyFields.length === 1 ? 'change' : 'changes'} · Not
              applied{advancedDirty ? ` · ${advancedDirty} in Advanced` : ''}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="flex min-w-0 flex-col gap-6">
        {renderSections(platform ? fields.filter((field) => BASIC_KEYS[field.key]) : fields)}
        {platform ? (
          <>
            <PolicySummary
              entries={entries}
              advancedDirty={advancedDirty}
              advancedErrors={Object.keys(errors).some(
                (key) => !BASIC_KEYS[key] && Boolean(errors[key]),
              )}
              onEdit={() => setLevel('advanced')}
            />
            <div
              hidden={level !== 'advanced'}
              className={level === 'advanced' ? 'flex flex-col gap-6' : undefined}
            >
              <Callout tone="warning" title="Identity trust">
                When trust is on, a verified provider email claim can link to an existing account
                without separate email proof.
              </Callout>
              {renderSections(fields.filter((field) => !BASIC_KEYS[field.key]))}
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}

export function SettingsReviewSummary({
  entries,
  fields,
  reviewValues,
}: {
  entries: Entries;
  fields: readonly SettingField[];
  reviewValues: Record<string, unknown>;
}) {
  const reviewFields = fields.filter((field) => field.key in reviewValues);
  const lowersRetention = reviewFields.some((field) => {
    if (!field.key.startsWith('retention.') && field.key !== 'sandbox.purgeDays') return false;
    const entry = entries.find((item) => item.key === field.key);
    const next = reviewValues[field.key] === null ? entry?.default : reviewValues[field.key];
    return typeof entry?.value === 'number' && typeof next === 'number' && next < entry.value;
  });
  return (
    <span className="block">
      <span className="block">Platform-wide · All organizations · Live and Test</span>
      <span className="mt-3 block max-h-48 space-y-1 overflow-y-auto">
        {reviewFields.map((field) => {
          const entry = entries.find((item) => item.key === field.key);
          const resetValue = reviewValues[field.key] === null;
          return (
            <span key={field.key} className="block">
              <strong>{field.label}:</strong> {displayValue(field, entry?.value)} →{' '}
              {displayValue(field, resetValue ? entry?.default : reviewValues[field.key])}
              {resetValue ? ' (reset to default)' : ''}
            </span>
          );
        })}
      </span>
      {lowersRetention ? (
        <span className="mt-3 block">
          Lower retention can cause older records or versions to be deleted by a retention job.
        </span>
      ) : null}
    </span>
  );
}
