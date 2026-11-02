import { useState } from 'react';
import type { z } from 'zod';
import type { OrgSummarySchema } from '@/shared/contracts/orgs.ts';
import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import {
  Callout,
  Card,
  CardBody,
  CardHeader,
  FormField,
  FormGrid,
  Input,
  SaveBar,
  Select,
  toast,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from '@/web/ui/index.ts';
import { useIdentities } from '../identities/queries.ts';
import { accentWarnings, HEX } from './branding.ts';
import { ColorField } from './color-field.tsx';
import { PassBrandingCard, type PassColorsDraft } from './pass-branding.tsx';
import { useUpdateOrg } from './queries.ts';

type Org = z.infer<typeof OrgSummarySchema>;

const DEFAULT_IDENTITY = 'default';
const DEFAULT_ACCENT = '#0f766e';

export interface OrgDraft extends PassColorsDraft {
  name: string;
  identity: string;
  accent: string;
}

export function orgToDraft(org: Org): OrgDraft {
  const colors = org.branding.passColors;
  return {
    name: org.name,
    identity: org.defaultIdentityId ?? DEFAULT_IDENTITY,
    accent: org.branding.accent ?? '',
    background: colors?.background ?? '',
    foreground: colors?.foreground ?? '',
    label: colors?.label ?? '',
    logoHasName: org.branding.logoHasName ?? false,
  };
}

const COLOR_ERROR = 'Use a 6-digit hex like #0f766e.';

export function validateOrg(d: OrgDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!d.name.trim()) errors.name = 'Required.';
  if (d.accent && !HEX.test(d.accent)) errors.accent = COLOR_ERROR;
  const colors = [d.background, d.foreground, d.label];
  // Pass colours go together: all three or none.
  if (colors.some(Boolean))
    for (const key of ['background', 'foreground', 'label'] as const)
      if (!HEX.test(d[key])) errors[key] = d[key] ? COLOR_ERROR : 'Set all three colours.';
  return errors;
}

/** Support contacts and images are kept from the stored branding. */
export function orgPatch(d: OrgDraft, org: Org) {
  const { accent: _a, passColors: _p, logoHasName: _l, ...kept } = org.branding;
  return {
    name: d.name.trim(),
    defaultIdentityId: d.identity === DEFAULT_IDENTITY ? null : d.identity,
    branding: {
      ...kept,
      ...(d.accent ? { accent: d.accent } : {}),
      ...(d.background
        ? { passColors: { background: d.background, foreground: d.foreground, label: d.label } }
        : {}),
      ...(d.logoHasName ? { logoHasName: true } : {}),
    },
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
  const accentNotes = accentWarnings(draft.accent || DEFAULT_ACCENT);

  async function save() {
    const found = validateOrg(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    try {
      await update.mutateAsync(orgPatch(draft, org));
      toast.success('Organization saved');
    } catch (cause) {
      if (isApiError(cause) && Object.keys(cause.fields).length > 0) setErrors(cause.fields);
      else toast.error(errorMessage(cause));
    }
  }

  return (
    <>
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
            <FormGrid>
              <FormField label="Name" required error={errors.name}>
                {(p) => (
                  <Input
                    {...p}
                    value={draft.name}
                    onChange={(e) => patch({ name: e.target.value })}
                  />
                )}
              </FormField>
              <FormField label="Signing identity" error={errors.defaultIdentityId}>
                {(p) => (
                  <Select
                    {...p}
                    value={draft.identity}
                    onValueChange={(v) => patch({ identity: v })}
                    options={[
                      { value: DEFAULT_IDENTITY, label: 'Platform default' },
                      ...(identities.data?.items ?? []).map((i) => ({
                        value: i.id,
                        label: i.label,
                      })),
                    ]}
                  />
                )}
              </FormField>
              <ColorField
                label="Accent colour"
                value={draft.accent}
                fallback={DEFAULT_ACCENT}
                empty="Teal"
                error={errors.accent}
                help="Email header and links. Empty uses teal."
                onChange={(accent) => patch({ accent })}
              />
            </FormGrid>
            {accentNotes.length ? <Callout tone="warning" items={accentNotes} /> : null}
          </form>
        </CardBody>
      </Card>
      <PassBrandingCard org={org} draft={draft} errors={errors} onChange={patch} />
      <SaveBar
        dirty={dirty}
        saving={update.isPending}
        paused={update.isPaused}
        onSave={() => void save()}
        onDiscard={() => {
          setDraft(initial);
          setErrors({});
        }}
      />
      <UnsavedChangesDialog blocker={guard} />
    </>
  );
}
