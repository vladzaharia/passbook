import {
  Braces,
  Calendar,
  ChevronRight,
  Globe,
  Hash,
  Image,
  Link2,
  List,
  Mail,
  ToggleLeft,
  Type,
} from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { issueWords } from '@/shared/copy/issues.ts';
import {
  Button,
  Callout,
  Card,
  CardBody,
  JsonViewer,
  KeyValue,
  ListRow,
  ListRows,
  toast,
} from '../../ui/index.ts';
import { describeSchema, flatFields } from '../passes/schema-form/index.ts';
import { useTemplateActions } from './api.ts';
import { JoinSection } from './join/join-section.tsx';
import { styleList } from './labels.ts';

type Template = z.infer<typeof TemplateDetailSchema>;

/** Details (org with Change, passes link) and the active version's warnings. */
export function TemplateOverview({
  template: t,
  canAssign,
}: {
  template: Template;
  canAssign: boolean;
}) {
  const actions = useTemplateActions(t.id);
  const shareable = canAssign && t.orgId === null && t.origin === 'uploaded' && !t.blueprint;
  async function toggleShared() {
    try {
      await actions.share.mutateAsync(!t.shared);
      toast.success(t.shared ? 'Sharing stopped' : 'Shared with all orgs');
    } catch (cause) {
      toast.error(cause, 'Could not change sharing');
    }
  }
  const active = t.versions.find((v) => v.active);
  const warnings = (active?.report.issues ?? []).filter((i) => i.severity !== 'error');
  return (
    <div className="grid gap-6">
      <Card>
        <CardBody>
          <KeyValue
            items={[
              ...(shareable
                ? [
                    {
                      label: 'Sharing',
                      value: (
                        <span className="flex min-w-0 flex-wrap items-center gap-2">
                          <span>{t.shared ? 'All orgs' : 'Platform only'}</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={actions.share.isPending}
                            onClick={toggleShared}
                          >
                            {t.shared ? 'Stop sharing' : 'Share with all orgs'}
                          </Button>
                        </span>
                      ),
                    },
                  ]
                : []),
              { label: 'Styles', value: styleList(t.styles) },
              { label: 'Slug', value: t.slug, mono: true },
            ]}
          />
        </CardBody>
      </Card>
      <JoinSection template={t} />
      {warnings.length > 0 ? (
        <Callout
          tone="warning"
          title={`${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'} in the active version`}
          items={warnings.map(issueWords)}
        />
      ) : null}
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
  timezone: Globe,
  'access-plan': List,
  'access-zones': List,
  list: List,
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
  timezone: 'Time zone',
  'access-plan': 'Plan',
  'access-zones': 'Zones',
  list: 'List',
};

/** Inputs as rows with a type glyph; the raw schema sits behind a disclosure. */
export function TemplateInputs({ schema }: { schema: unknown }) {
  const fields = flatFields(describeSchema(schema));
  const [open, setOpen] = useState(false);
  return (
    <div className="grid gap-6">
      <Card>
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
