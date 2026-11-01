import { Link } from '@tanstack/react-router';
import {
  Braces,
  Calendar,
  ChevronRight,
  Hash,
  Image,
  Link2,
  List,
  Mail,
  Pencil,
  ToggleLeft,
  Type,
} from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  EntityAvatar,
  JsonViewer,
  KeyValue,
  ListRow,
  ListRows,
} from '../../ui/index.ts';
import { describeSchema, flatFields } from '../passes/schema-form/index.ts';
import { styleList } from './labels.ts';
import { OrgDialog } from './template-dialogs.tsx';

type Template = z.infer<typeof TemplateDetailSchema>;
const passes = (n: number) => `${n} ${n === 1 ? 'pass' : 'passes'}`;

/** Details (org with Change, passes link) and the active version's warnings. */
export function TemplateOverview({ template: t }: { template: Template }) {
  const [changing, setChanging] = useState(false);
  const active = t.versions.find((v) => v.active);
  const warnings = (active?.report.issues ?? []).filter((i) => i.severity !== 'error');
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader title="Details" />
        <CardBody>
          <KeyValue
            items={[
              {
                label: 'Organization',
                value: (
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    {t.orgId ? (
                      <EntityAvatar kind="org" id={t.orgId} name={t.orgName ?? ''} />
                    ) : null}
                    <span className="truncate">{t.orgName ?? 'All organizations'}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconStart={<Pencil aria-hidden />}
                      aria-label="Change organization"
                      onClick={() => setChanging(true)}
                    >
                      Change
                    </Button>
                  </span>
                ),
              },
              {
                label: 'Passes',
                value: (
                  <Link
                    to="/admin/passes"
                    search={{ templateId: t.id }}
                    className="inline-flex items-center gap-1 underline-offset-2 hover:text-fg-strong hover:underline"
                  >
                    {passes(t.passCount)}
                    <ChevronRight aria-hidden className="size-3.5" />
                  </Link>
                ),
              },
              ...(t.passesOnOlderVersions > 0
                ? [{ label: 'Older versions', value: passes(t.passesOnOlderVersions) }]
                : []),
              { label: 'Styles', value: styleList(t.styles) },
              { label: 'Slug', value: t.slug, mono: true },
            ]}
          />
        </CardBody>
      </Card>
      {warnings.length > 0 ? (
        <Callout
          tone="warning"
          title={`${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'} · affects ${passes(t.passCount)}`}
          items={warnings.map((w) => w.message)}
        />
      ) : null}
      <OrgDialog key={String(changing)} template={t} open={changing} onOpenChange={setChanging} />
    </div>
  );
}

const TYPE_ICON = {
  text: Type,
  textarea: Type,
  number: Hash,
  boolean: ToggleLeft,
  select: List,
  date: Calendar,
  datetime: Calendar,
  url: Link2,
  email: Mail,
  image: Image,
  password: Type,
} as const;
const TYPE_LABEL: Record<string, string> = {
  text: 'Text',
  textarea: 'Long text',
  number: 'Number',
  boolean: 'On or off',
  select: 'Choice',
  date: 'Date',
  datetime: 'Date and time',
  url: 'Link',
  email: 'Email',
  image: 'Image',
  password: 'Secret',
};

/** Inputs as rows with a type glyph; the raw schema sits behind a disclosure. */
export function TemplateInputs({ schema }: { schema: unknown }) {
  const fields = flatFields(describeSchema(schema));
  const [open, setOpen] = useState(false);
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader title="Inputs" />
        <CardBody>
          {fields.length === 0 ? (
            <p className="text-sm text-fg-muted">No inputs.</p>
          ) : (
            <ListRows label="Inputs">
              {fields.map((f) => {
                const Icon = TYPE_ICON[f.widget] ?? Type;
                return (
                  <ListRow
                    key={f.key}
                    leading={<Icon aria-hidden />}
                    title={f.label}
                    meta={<span className="font-mono">{f.key}</span>}
                    trailing={
                      <span className="text-xs text-fg-muted">
                        {TYPE_LABEL[f.widget] ?? 'Text'}
                        {f.required ? ' · Required' : ''}
                      </span>
                    }
                  />
                );
              })}
            </ListRows>
          )}
        </CardBody>
      </Card>
      <Card>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-2 rounded-lg px-4 py-3 text-left text-sm font-semibold text-fg-strong hover:bg-state-hover-tint focus-visible:outline-2 focus-visible:outline-focus"
        >
          <ChevronRight
            aria-hidden
            className={`wl-chevron size-4 text-fg-muted ${open ? 'rotate-90' : ''}`}
          />
          <Braces aria-hidden className="size-4 text-fg-muted" />
          Input schema
        </button>
        {open ? (
          <div className="border-t border-border p-4">
            <JsonViewer value={schema} label="Input schema" maxHeight="max-h-[32rem]" />
          </div>
        ) : null}
      </Card>
    </div>
  );
}
