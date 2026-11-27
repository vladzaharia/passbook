import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { GroupRule } from '@/shared/contracts/idp-access.ts';
import type { OrgRole } from '@/shared/contracts/org-membership.ts';
import { GROUP_COPY } from '@/shared/copy/idp-platform.ts';
import { endRuleConfirm } from '@/web/lib/confirms-idp.ts';
import { ENTITY } from '@/web/lib/entities.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  FormDialog,
  FormField,
  ListRow,
  ListRows,
  RowActions,
  SkeletonRows,
  toast,
  useFormErrors,
} from '@/web/ui/index.ts';
import { useOrgNames } from '../../orgs/queries.ts';
import { useGroupActions, useGroupRules } from './queries.ts';
import { RoleChips, RuleOrgPicker, rolesText } from './rule-fields.tsx';

/** Members of an org join the group while they hold an active membership; ending a rule removes what it added. */
export function GroupRulesCard({ groupKey }: { groupKey: string }) {
  const rules = useGroupRules(groupKey);
  const orgName = useOrgNames();
  const { endRule } = useGroupActions();
  const [adding, setAdding] = useState(false);
  const [ending, setEnding] = useState<GroupRule | null>(null);
  const items = rules.data?.items ?? [];
  const copy = endRuleConfirm(ending ? orgName(ending.orgId) : '');
  return (
    <Card>
      <CardHeader
        title="Rules"
        actions={
          <Button
            size="sm"
            variant="outline"
            iconStart={<Plus aria-hidden />}
            onClick={() => setAdding(true)}
          >
            Add rule
          </Button>
        }
      />
      <CardBody>
        {rules.isPending ? (
          <SkeletonRows label="Loading rules" />
        ) : rules.isError ? (
          <ErrorState inline subject="rules" error={rules.error} onRetry={() => rules.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState inline art={ENTITY.org.art} title={GROUP_COPY.noRules} />
        ) : (
          <ListRows label="Org rules">
            {items.map((rule) => (
              <ListRow
                key={rule.id}
                rowId={rule.id}
                leading={<ENTITY.org.icon aria-hidden className="size-4 text-fg-muted" />}
                title={orgName(rule.orgId)}
                meta={rolesText(rule.orgRoles)}
                trailing={
                  <RowActions
                    label={`Actions for ${orgName(rule.orgId)}`}
                    actions={[
                      {
                        label: 'End rule',
                        icon: Trash2,
                        destructive: true,
                        onSelect: () => setEnding(rule),
                      },
                    ]}
                  />
                }
              />
            ))}
          </ListRows>
        )}
      </CardBody>
      <AddRuleDialog
        groupKey={groupKey}
        open={adding}
        onOpenChange={setAdding}
        taken={items.map((r) => r.orgId)}
      />
      <ConfirmDialog
        open={ending !== null}
        onOpenChange={(open) => !open && setEnding(null)}
        title={copy.title}
        description={copy.description}
        confirmLabel={copy.confirmLabel}
        destructive
        onConfirm={async () => {
          if (!ending) return;
          await endRule.mutateAsync({ key: groupKey, id: ending.id });
          toast.success('Rule ended');
        }}
      />
    </Card>
  );
}

function AddRuleDialog({
  groupKey,
  open,
  onOpenChange,
  taken,
}: {
  groupKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taken: readonly string[];
}) {
  const { addRule } = useGroupActions();
  const [orgId, setOrgId] = useState<string>();
  const [roles, setRoles] = useState<OrgRole[]>([]);
  const check = useFormErrors(orgId ? {} : { orgId: 'Pick an organization.' });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add rule"
      size="sm"
      dirty={Boolean(orgId) || roles.length > 0}
      check={check}
      submitLabel="Add rule"
      busy={addRule.isPending}
      onClose={() => {
        setOrgId(undefined);
        setRoles([]);
      }}
      onSubmit={async () => {
        if (!orgId) return;
        await addRule.mutateAsync({
          key: groupKey,
          rule: { orgId, ...(roles.length > 0 ? { orgRoles: roles } : {}) },
        });
        toast.success('Rule added');
        onOpenChange(false);
      }}
    >
      {({ errors }) => (
        <>
          <FormField label="Organization" required error={check.errors.orgId ?? errors.orgId}>
            {(control) => (
              <RuleOrgPicker {...control} value={orgId} onValueChange={setOrgId} taken={taken} />
            )}
          </FormField>
          <RoleChips value={roles} onChange={setRoles} />
        </>
      )}
    </FormDialog>
  );
}
