import { useState } from 'react';
import type { z } from 'zod';
import type { OrgSummarySchema } from '@/shared/contracts/orgs.ts';
import { isApiError } from '@/web/lib/errors.ts';
import { handleStaleSave } from '@/web/lib/stale-save.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Form,
  FormField,
  FormGrid,
  Input,
  SaveBar,
  type SaveResult,
  Select,
  toast,
  UnsavedChangesDialog,
  useFormErrors,
  useSavedToast,
  useUnsavedChangesGuard,
} from '@/web/ui/index.ts';
import { useIdentityOptions } from '../identities/queries.ts';
import { HEX } from './branding.ts';
import { ColorField } from './color-field.tsx';
import { PassBrandingCard, type PassColorsDraft } from './pass-branding.tsx';
import { passUpdateText, useRefreshOrgs, useUpdateOrg } from './queries.ts';

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
    ...(org.configRevision === undefined ? {} : { configRevision: org.configRevision }),
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

const FORM_ID = 'org-form';

export function OrgForm({ org, canChooseIdentity }: { org: Org; canChooseIdentity: boolean }) {
  const update = useUpdateOrg(org.id);
  const refresh = useRefreshOrgs();
  const identities = useIdentityOptions(canChooseIdentity);
  const initial = orgToDraft(org);
  const [edits, setEdits] = useState<Partial<OrgDraft>>({});
  const draft = { ...initial, ...edits };
  const [server, setServer] = useState<Record<string, string>>({});
  const check = useFormErrors(validateOrg(draft));
  const errors = { ...server, ...check.errors } as Record<string, string>;
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const guard = useUnsavedChangesGuard(dirty);
  const saved = useSavedToast();
  const patch = (p: Partial<OrgDraft>) => {
    setEdits((current) => {
      const next = { ...current, ...p };
      for (const key of Object.keys(p) as (keyof OrgDraft)[]) {
        if (next[key] === initial[key]) delete next[key];
      }
      return next;
    });
    setServer({});
  };
  const availableIdentities = (identities.data?.items ?? []).filter(
    (identity) => identity.orgId === null || identity.orgId === org.id,
  );
  const missingIdentities = [...new Set([org.defaultIdentityId, draft.identity])].filter(
    (id): id is string =>
      typeof id === 'string' &&
      id !== DEFAULT_IDENTITY &&
      !availableIdentities.some((identity) => identity.id === id),
  );

  async function save(): Promise<SaveResult> {
    try {
      const body = orgPatch(draft, org);
      const { defaultIdentityId: _identity, ...tenantBody } = body;
      const result = await update.mutateAsync(canChooseIdentity ? body : tenantBody);
      setEdits((current) => {
        const remaining = { ...current };
        for (const key of Object.keys(current) as (keyof OrgDraft)[]) {
          if (current[key] === draft[key]) delete remaining[key];
        }
        return remaining;
      });
      saved('Organization saved', passUpdateText(result.passesToUpdate));
      return 'saved';
    } catch (cause) {
      if (handleStaleSave(cause, refresh)) return 'refused';
      if (isApiError(cause) && Object.keys(cause.fields).length > 0) {
        setServer(cause.fields);
        return 'refused';
      }
      toast.error(cause, 'Could not save');
      return 'failed';
    }
  }

  // Both cards are one form: Save checks the pass colours too and focuses the first error.
  return (
    <Form id={FORM_ID} className="flex flex-col gap-6" {...check.form} onValid={save}>
      <Card>
        <CardHeader title="Organization details" />
        <CardBody>
          <div className="flex flex-col gap-4">
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
              {canChooseIdentity ? (
                <FormField
                  label="Signing identity"
                  error={errors.defaultIdentityId}
                  help={
                    <>
                      The default for new passes, not a migration of existing passes. Only this
                      organization&apos;s and platform identities can be selected.
                      {identities.isPending
                        ? ' Loading identities…'
                        : identities.isError
                          ? ' Identity options could not be loaded.'
                          : identities.data?.nextCursor
                            ? ' Only the first 200 identities are listed.'
                            : ''}
                    </>
                  }
                >
                  {(p) => (
                    <>
                      <Select
                        {...p}
                        value={draft.identity}
                        onValueChange={(v) => patch({ identity: v })}
                        options={[
                          { value: DEFAULT_IDENTITY, label: 'Platform default' },
                          ...missingIdentities.map((id) => ({
                            value: id,
                            label:
                              id === org.defaultIdentityId
                                ? 'Saved identity (details unavailable)'
                                : 'Selected identity (details unavailable)',
                          })),
                          ...availableIdentities.map((i) => ({ value: i.id, label: i.label })),
                        ]}
                      />
                      {identities.isError ? (
                        <Button variant="ghost" size="sm" onClick={() => void identities.refetch()}>
                          Retry identities
                        </Button>
                      ) : null}
                    </>
                  )}
                </FormField>
              ) : null}
              <ColorField
                label="Accent colour"
                value={draft.accent}
                fallback={DEFAULT_ACCENT}
                empty="Teal"
                error={errors.accent}
                help="Subtle accent on scan screens and the org avatar. Empty uses teal."
                onChange={(accent) => patch({ accent })}
              />
            </FormGrid>
          </div>
        </CardBody>
      </Card>
      <PassBrandingCard org={org} draft={draft} errors={errors} onChange={patch} />
      <SaveBar
        dirty={dirty}
        saving={update.isPending}
        paused={update.isPaused}
        formId={FORM_ID}
        onDiscard={() => {
          setEdits({});
          setServer({});
          check.reset();
        }}
      />
      <UnsavedChangesDialog blocker={guard} />
    </Form>
  );
}
