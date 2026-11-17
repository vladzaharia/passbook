import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import type { TemplateSummaryDto } from '@/shared/contracts/templates.ts';
import { errorMessage } from '../../lib/errors.ts';
import { PHONE, useMediaQuery } from '../../lib/media.ts';
import { markMinted } from '../../lib/motion.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { Button, Dialog, DialogContent, FormField, Input, Select } from '../../ui/index.ts';
import { markCreated } from '../passes/created.tsx';
import { useUseBlueprint } from './api.ts';

type Blueprint = Pick<TemplateSummaryDto, 'id' | 'name'>;

/**
 * Use blueprint: an organization and a name. Continue opens the designer on a draft; on a phone
 * the designer is out of reach, so the dialog makes the template as it is.
 */
export function UseBlueprintDialog({
  blueprint,
  open,
  onOpenChange,
}: {
  blueprint: Blueprint;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const phone = useMediaQuery(PHONE);
  const navigate = useNavigate();
  const scope = useOrgScope();
  // Only organizations where the person authors templates can receive one.
  const orgs = useMemo(
    () => scope.memberships.filter((m) => m.capabilities.includes('templates:author')),
    [scope.memberships],
  );
  const fallback = orgs.find((m) => m.orgId === scope.orgId)?.orgId ?? orgs[0]?.orgId;
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [name, setName] = useState(blueprint.name);
  const [error, setError] = useState<{ org?: string; name?: string; form?: string }>({});
  const create = useUseBlueprint(blueprint.id);
  const orgId = chosen ?? fallback;

  function check(): { orgId: string; name: string } | null {
    const next = name.trim();
    const problems = {
      ...(orgId ? {} : { org: 'Choose an organization.' }),
      ...(next ? {} : { name: 'Enter a name.' }),
    };
    setError(problems);
    return orgId && next ? { orgId, name: next } : null;
  }

  async function submit() {
    const input = check();
    if (!input) return;
    if (!phone) {
      onOpenChange(false);
      void navigate({
        to: '/admin/templates/new',
        search: { blueprint: blueprint.id, orgId: input.orgId, name: input.name },
      });
      return;
    }
    try {
      const made = await create.mutateAsync(input);
      markMinted(`template:${made.id}`);
      markCreated(`template:${made.id}`, 'fromBlueprint');
      onOpenChange(false);
      void navigate({
        to: '/admin/templates/$templateId',
        params: { templateId: made.id },
        search: { orgId: input.orgId },
      });
    } catch (cause) {
      setError({ form: errorMessage(cause) });
    }
  }

  return (
    <Dialog
      open={open}
      dirty={name !== blueprint.name || chosen !== undefined}
      onOpenChange={onOpenChange}
    >
      <DialogContent
        title="Use blueprint"
        description={`${blueprint.name} becomes a template of your own.`}
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button loading={create.isPending} onClick={() => void submit()}>
              {phone ? 'Create template' : 'Continue'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <FormField label="Organization" required error={error.org}>
            {(c) => (
              <Select
                {...c}
                value={orgId}
                placeholder="Choose an organization"
                onValueChange={(v) => {
                  setChosen(v);
                  setError({});
                }}
                options={orgs.map((m) => ({ value: m.orgId, label: m.orgName }))}
              />
            )}
          </FormField>
          <FormField label="Name" required error={error.name ?? error.form}>
            {(c) => (
              <Input
                {...c}
                data-autofocus
                value={name}
                maxLength={120}
                onChange={(e) => {
                  setName(e.target.value);
                  setError({});
                }}
              />
            )}
          </FormField>
        </div>
      </DialogContent>
    </Dialog>
  );
}
