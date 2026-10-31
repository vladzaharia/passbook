import { useState } from 'react';
import { toast } from 'sonner';
import type { z } from 'zod';
import type { OrgSummarySchema } from '@/shared/contracts/orgs.ts';
import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import {
  Card,
  CardBody,
  CardHeader,
  FormField,
  Input,
  SaveBar,
  Select,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from '@/web/ui/index.ts';
import { useIdentities } from '../identities/queries.ts';
import { useUpdateOrg } from './queries.ts';

type Org = z.infer<typeof OrgSummarySchema>;

const DEFAULT_IDENTITY = 'default';
const HEX = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_ACCENT = '#0f766e';

export interface OrgDraft {
  name: string;
  status: 'active' | 'suspended';
  identity: string;
  accent: string;
}

export function orgToDraft(org: Org): OrgDraft {
  return {
    name: org.name,
    status: org.status === 'suspended' ? 'suspended' : 'active',
    identity: org.defaultIdentityId ?? DEFAULT_IDENTITY,
    accent: org.branding.accent ?? '',
  };
}

export function validateOrg(d: OrgDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!d.name.trim()) errors.name = 'Required.';
  if (d.accent && !HEX.test(d.accent)) errors.accent = 'Use a 6-digit hex like #0f766e.';
  return errors;
}

/** Support contacts are kept from the current branding; they are edited as org settings. */
export function orgPatch(d: OrgDraft, org: Org) {
  const branding: Record<string, string> = { ...org.branding };
  if (d.accent) branding.accent = d.accent;
  else delete branding.accent;
  return {
    name: d.name.trim(),
    status: d.status,
    defaultIdentityId: d.identity === DEFAULT_IDENTITY ? null : d.identity,
    branding,
  };
}

export function OrgForm({ org }: { org: Org }) {
  const update = useUpdateOrg(org.id);
  const identities = useIdentities();
  const initial = orgToDraft(org);
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const guard = useUnsavedChangesGuard(dirty);
  const patch = (p: Partial<OrgDraft>) => setDraft((d) => ({ ...d, ...p }));

  async function save() {
    const found = validateOrg(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    try {
      await update.mutateAsync(orgPatch(draft, org));
      toast.success('Organization saved');
    } catch (cause) {
      if (isApiError(cause) && Object.keys(cause.fields).length > 0) {
        setErrors(cause.fields);
      } else {
        toast.error(errorMessage(cause));
      }
    }
  }

  return (
    <Card>
      <CardHeader title="Details" />
      <CardBody>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <FormField label="Name" required error={errors.name}>
            {(p) => (
              <Input {...p} value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
            )}
          </FormField>
          <FormField label="Status" error={errors.status}>
            {(p) => (
              <Select
                {...p}
                value={draft.status}
                onValueChange={(v) => patch({ status: v as OrgDraft['status'] })}
                options={[
                  { value: 'active', label: 'Active' },
                  { value: 'suspended', label: 'Suspended' },
                ]}
              />
            )}
          </FormField>
          <FormField label="Default identity" error={errors.defaultIdentityId}>
            {(p) => (
              <Select
                {...p}
                value={draft.identity}
                onValueChange={(v) => patch({ identity: v })}
                options={[
                  { value: DEFAULT_IDENTITY, label: 'Platform default' },
                  ...(identities.data?.items ?? []).map((i) => ({ value: i.id, label: i.label })),
                ]}
              />
            )}
          </FormField>
          <FormField label="Accent colour" error={errors.accent} help="Empty uses the default.">
            {(p) => (
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label="Accent colour picker"
                  value={HEX.test(draft.accent) ? draft.accent : DEFAULT_ACCENT}
                  onChange={(e) => patch({ accent: e.target.value })}
                  className="size-9 shrink-0 cursor-pointer rounded-md border border-border-strong bg-transparent p-0.5"
                />
                <Input
                  {...p}
                  className="max-w-40 font-mono"
                  placeholder={DEFAULT_ACCENT}
                  value={draft.accent}
                  onChange={(e) => patch({ accent: e.target.value.trim() })}
                />
              </div>
            )}
          </FormField>
        </form>
      </CardBody>
      <SaveBar
        dirty={dirty}
        saving={update.isPending}
        onSave={() => void save()}
        onDiscard={() => {
          setDraft(initial);
          setErrors({});
        }}
      />
      <UnsavedChangesDialog blocker={guard} />
    </Card>
  );
}
