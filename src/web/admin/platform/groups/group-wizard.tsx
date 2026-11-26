import { useNavigate } from '@tanstack/react-router';
import { Users } from 'lucide-react';
import { useState } from 'react';
import type { GroupResult } from '@/shared/contracts/idp-access.ts';
import { IDP_COPY } from '@/shared/copy/idp.ts';
import { groupName } from '@/shared/copy/idp-platform.ts';
import { Button, useWizard, WizardDialog, WizardReview } from '@/web/ui/index.ts';
import { useOrgNames } from '../../orgs/queries.ts';
import { StepName, StepRules } from './group-wizard-steps.tsx';
import { useGroupActions } from './queries.ts';
import { rolesText } from './rule-fields.tsx';
import { FIELD_STEP, HINTS, STEPS, useGroupForm } from './use-group-form.ts';

/** New group: name and key, optional org rules, review. Members and claims are added on the group's page. */
export function GroupWizard({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { create } = useGroupActions();
  const navigate = useNavigate();
  const orgName = useOrgNames();
  const form = useGroupForm();
  const [made, setMade] = useState<GroupResult>();
  const w = useWizard({
    open,
    steps: STEPS.map((s) => ({
      ...s,
      summary:
        s.id === 'name' && form.name.trim()
          ? form.name.trim()
          : s.id === 'rules' && form.rules.length > 0
            ? `${form.rules.length} ${form.rules.length === 1 ? 'rule' : 'rules'}`
            : undefined,
    })),
    errors: form.errors,
    hints: HINTS,
    fieldStep: FIELD_STEP,
    onFinish: async () =>
      setMade(
        await create.mutateAsync({
          key: form.key,
          friendlyName: form.name.trim(),
          ...(form.rules.length > 0
            ? {
                rules: form.rules.map((r) => ({
                  orgId: r.orgId,
                  ...(r.orgRoles.length > 0 ? { orgRoles: r.orgRoles } : {}),
                })),
              }
            : {}),
        }),
      ),
  });
  const done = () => onOpenChange(false);
  return (
    <WizardDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New group"
      wizard={w}
      dirty={form.dirty}
      finishLabel="Create group"
      busy={create.isPending}
      onClose={() => {
        form.reset();
        setMade(undefined);
      }}
      result={
        made
          ? {
              title: made.dryRun ? 'Dry run' : 'Group created',
              icon: <Users aria-hidden />,
              body: (
                <div className="flex flex-col gap-4">
                  <p className="text-sm text-fg-muted">
                    {made.dryRun ? IDP_COPY.dryRun : `${groupName(made.key)} is in Polaris ID.`}
                  </p>
                  <div className="flex justify-end gap-2">
                    <Button variant={made.dryRun ? 'primary' : 'outline'} onClick={done}>
                      Done
                    </Button>
                    {made.dryRun ? null : (
                      <Button
                        onClick={() => {
                          done();
                          void navigate({
                            to: '/admin/platform/groups/$key',
                            params: { key: made.key },
                          });
                        }}
                      >
                        Open group
                      </Button>
                    )}
                  </div>
                </div>
              ),
            }
          : undefined
      }
    >
      {w.id === 'name' ? <StepName form={form} errors={w.errors} /> : null}
      {w.id === 'rules' ? <StepRules form={form} errors={w.errors} /> : null}
      {w.id === 'review' ? (
        <WizardReview
          onEdit={w.go}
          sections={[
            {
              id: 'name',
              title: 'Name',
              items: [
                { label: 'Name', value: form.name.trim() },
                { label: 'Polaris ID name', value: groupName(form.key), mono: true },
              ],
            },
            {
              id: 'rules',
              title: 'Rules',
              items:
                form.rules.length > 0
                  ? form.rules.map((r) => ({
                      label: orgName(r.orgId),
                      value: rolesText(r.orgRoles),
                    }))
                  : [{ label: 'Org rules', value: 'None' }],
            },
          ]}
        />
      ) : null}
    </WizardDialog>
  );
}
