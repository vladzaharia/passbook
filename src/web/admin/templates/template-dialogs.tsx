import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import type { z } from 'zod';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { errorMessage } from '../../lib/errors.ts';
import { markMinted } from '../../lib/motion.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { useOrgOptions } from '../../lib/search.ts';
import { useSession } from '../../lib/session.ts';
import { Button, Dialog, DialogContent, FormField, Input, Select, toast } from '../../ui/index.ts';
import { markCreated } from '../passes/created.tsx';
import { useTemplateActions } from './api.ts';

type Template = z.infer<typeof TemplateDetailSchema>;
const ALL = 'all';

/** An uploaded copy for one org; its page mints the card on arrival and says what happened. */
export function DuplicateDialog({
  template,
  open,
  onOpenChange,
  to = 'detail',
}: {
  template: Template;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Where the copy opens: its page, or straight into its designer. */
  to?: 'detail' | 'design';
}) {
  const orgs = useOrgOptions(open);
  const scope = useOrgScope();
  const actions = useTemplateActions(template.id);
  const navigate = useNavigate();
  const [orgId, setOrgId] = useState<string | undefined>(template.orgId ?? undefined);
  const [name, setName] = useState(`${template.name} copy`);
  const [error, setError] = useState<string>();

  async function duplicate() {
    if (!orgId) return setError('Choose an organization.');
    if (
      scope.isLoading ||
      scope.isError ||
      !scope.orgId ||
      (template.orgId !== null && template.orgId !== scope.orgId) ||
      !scope.membership?.capabilities.includes('templates:author') ||
      !scope.memberships.some(
        (m) => m.orgId === orgId && m.capabilities.includes('templates:author'),
      )
    ) {
      return setError('Choose an organization where you can author templates.');
    }
    try {
      const copy = await actions.clone.mutateAsync({ orgId, name: name.trim() || undefined });
      markMinted(`template:${copy.id}`);
      markCreated(`template:${copy.id}`, 'duplicated');
      onOpenChange(false);
      void navigate(
        to === 'design'
          ? {
              to: '/admin/templates/$templateId/design',
              params: { templateId: copy.id },
              search: { orgId: copy.orgId ?? orgId },
            }
          : {
              to: '/admin/templates/$templateId',
              params: { templateId: copy.id },
              search: { orgId: copy.orgId ?? orgId },
            },
      );
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <Dialog
      open={open}
      dirty={name !== `${template.name} copy` || orgId !== (template.orgId ?? undefined)}
      onOpenChange={onOpenChange}
    >
      <DialogContent
        title="Duplicate template"
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button loading={actions.clone.isPending} onClick={() => void duplicate()}>
              Duplicate
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <FormField label="Name">
            {(c) => (
              <Input {...c} data-autofocus value={name} onChange={(e) => setName(e.target.value)} />
            )}
          </FormField>
          <FormField label="Organization" required error={error}>
            {(c) => (
              <Select
                {...c}
                value={orgId}
                onValueChange={(v) => {
                  setOrgId(v);
                  setError(undefined);
                }}
                options={(orgs.data?.items ?? [])
                  .filter((o) =>
                    scope.memberships.some(
                      (m) => m.orgId === o.id && m.capabilities.includes('templates:author'),
                    ),
                  )
                  .map((o) => ({ value: o.id, label: o.name }))}
              />
            )}
          </FormField>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Who may use the template: one organization or all of them. */
export function OrgDialog({
  template,
  open,
  onOpenChange,
}: {
  template: Template;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const orgs = useOrgOptions(open);
  const scope = useOrgScope();
  const { isAdmin } = useSession();
  const navigate = useNavigate();
  const actions = useTemplateActions(template.id);
  const [value, setValue] = useState(template.orgId ?? ALL);
  const [error, setError] = useState<string>();
  async function save() {
    if (
      !isAdmin ||
      scope.isLoading ||
      scope.isError ||
      !scope.orgId ||
      (template.orgId !== null && template.orgId !== scope.orgId) ||
      !scope.membership?.capabilities.includes('templates:author') ||
      (value !== ALL &&
        !scope.memberships.some(
          (m) => m.orgId === value && m.capabilities.includes('templates:author'),
        ))
    ) {
      return setError('Choose an organization where you can author templates.');
    }
    try {
      const updated = await actions.assignOrg.mutateAsync(value === ALL ? null : value);
      if (updated.orgId && updated.orgId !== scope.orgId) {
        void navigate({
          to: '/admin/templates/$templateId',
          params: { templateId: updated.id },
          search: { orgId: updated.orgId },
          replace: true,
        });
      }
      toast.success('Organization changed');
      onOpenChange(false);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  return (
    <Dialog open={open} dirty={value !== (template.orgId ?? ALL)} onOpenChange={onOpenChange}>
      <DialogContent
        title="Change organization"
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              loading={actions.assignOrg.isPending}
              disabled={value === (template.orgId ?? ALL)}
              onClick={() => void save()}
            >
              Save
            </Button>
          </>
        }
      >
        <FormField label="Organization" error={error}>
          {(c) => (
            <Select
              {...c}
              value={value}
              onValueChange={(v) => {
                setValue(v);
                setError(undefined);
              }}
              options={[
                { value: ALL, label: 'All organizations' },
                ...(orgs.data?.items ?? [])
                  .filter((o) =>
                    scope.memberships.some(
                      (m) => m.orgId === o.id && m.capabilities.includes('templates:author'),
                    ),
                  )
                  .map((o) => ({ value: o.id, label: o.name })),
              ]}
            />
          )}
        </FormField>
      </DialogContent>
    </Dialog>
  );
}
