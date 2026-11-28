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
import { useIdentityOptions } from '../wallet-accounts/apple/queries.ts';
import { useRefreshOrgs, useUpdateOrg } from './queries.ts';

type Org = z.infer<typeof OrgSummarySchema>;

const DEFAULT_IDENTITY = 'default';

export interface OrgDraft {
  name: string;
  identity: string;
}

export function orgToDraft(org: Org): OrgDraft {
  return { name: org.name, identity: org.defaultIdentityId ?? DEFAULT_IDENTITY };
}

export function validateOrg(d: OrgDraft): Record<string, string> {
  return d.name.trim() ? {} : { name: 'Required.' };
}

/** The name and the signing identity; brand lives on Brand and channels. */
export function orgPatch(d: OrgDraft, org: Org) {
  return {
    name: d.name.trim(),
    defaultIdentityId: d.identity === DEFAULT_IDENTITY ? null : d.identity,
    ...(org.configRevision === undefined ? {} : { configRevision: org.configRevision }),
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
      await update.mutateAsync(canChooseIdentity ? body : tenantBody);
      setEdits((current) => {
        const remaining = { ...current };
        for (const key of Object.keys(current) as (keyof OrgDraft)[]) {
          if (current[key] === draft[key]) delete remaining[key];
        }
        return remaining;
      });
      saved('Organization saved');
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
                    identities.isPending
                      ? 'Loading identities…'
                      : identities.isError
                        ? 'Identity options could not be loaded.'
                        : identities.data?.nextCursor
                          ? 'Only the first 200 identities are listed.'
                          : undefined
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
            </FormGrid>
          </div>
        </CardBody>
      </Card>
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
