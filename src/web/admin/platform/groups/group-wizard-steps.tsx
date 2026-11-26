import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { OrgRole } from '@/shared/contracts/org-membership.ts';
import { GROUP_COPY, groupName } from '@/shared/copy/idp-platform.ts';
import { ENTITY } from '@/web/lib/entities.ts';
import {
  Button,
  Callout,
  FormField,
  Input,
  ListRow,
  ListRows,
  RowActions,
} from '@/web/ui/index.ts';
import { useOrgNames } from '../../orgs/queries.ts';
import { RoleChips, RuleOrgPicker, rolesText } from './rule-fields.tsx';
import { type GroupForm, MAX_RULES } from './use-group-form.ts';

export function StepName({
  form,
  errors,
}: {
  form: GroupForm;
  errors: Record<string, string | undefined>;
}) {
  return (
    <>
      <FormField label="Name" required error={errors.friendlyName ?? errors.name}>
        {(control) => (
          <Input
            {...control}
            data-autofocus
            autoComplete="off"
            maxLength={50}
            placeholder="Partner apps"
            value={form.name}
            onChange={(event) => form.setName(event.target.value)}
          />
        )}
      </FormField>
      <FormField
        label="Key"
        required
        error={errors.key}
        help={
          <>
            Apps see <code className="font-mono">{groupName(form.key || 'key')}</code>.{' '}
            {GROUP_COPY.keyFixed}
          </>
        }
      >
        {(control) => (
          <Input
            {...control}
            autoComplete="off"
            spellCheck={false}
            maxLength={40}
            className="font-mono"
            value={form.key}
            onChange={(event) => form.setKey(event.target.value)}
          />
        )}
      </FormField>
    </>
  );
}

/** Org rules, optional: members of the org join; add people by hand after creating. */
export function StepRules({
  form,
  errors,
}: {
  form: GroupForm;
  errors: Record<string, string | undefined>;
}) {
  const orgName = useOrgNames();
  const [orgId, setOrgId] = useState<string>();
  const [roles, setRoles] = useState<OrgRole[]>([]);
  const full = form.rules.length >= MAX_RULES;
  const add = () => {
    if (!orgId) return;
    form.addRule({ orgId, orgRoles: roles });
    setOrgId(undefined);
    setRoles([]);
  };
  return (
    <>
      {form.rules.length > 0 ? (
        <ListRows label="Org rules" className="rounded-lg border border-border px-4">
          {form.rules.map((rule) => (
            <ListRow
              key={rule.orgId}
              leading={<ENTITY.org.icon aria-hidden className="size-4 text-fg-muted" />}
              title={orgName(rule.orgId)}
              meta={rolesText(rule.orgRoles)}
              trailing={
                <RowActions
                  label={`Actions for ${orgName(rule.orgId)}`}
                  actions={[
                    {
                      label: 'Remove',
                      icon: Trash2,
                      destructive: true,
                      onSelect: () => form.removeRule(rule.orgId),
                    },
                  ]}
                />
              }
            />
          ))}
        </ListRows>
      ) : null}
      {full ? (
        <Callout tone="info">A group takes {MAX_RULES} org rules at most.</Callout>
      ) : (
        <div className="flex flex-col gap-4 rounded-lg border border-dashed border-border-strong p-4">
          <FormField label="Organization" error={errors.rules}>
            {(control) => (
              <RuleOrgPicker
                {...control}
                value={orgId}
                onValueChange={setOrgId}
                taken={form.rules.map((r) => r.orgId)}
              />
            )}
          </FormField>
          <RoleChips value={roles} onChange={setRoles} />
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={!orgId}
              iconStart={<Plus aria-hidden />}
              onClick={add}
            >
              Add rule
            </Button>
          </div>
        </div>
      )}
      {form.rules.length === 0 ? (
        <p className="text-xs text-fg-muted">{GROUP_COPY.noRules} Add one, or skip.</p>
      ) : null}
    </>
  );
}
