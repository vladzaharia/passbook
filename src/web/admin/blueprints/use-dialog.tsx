import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TemplateSummaryDto } from '@/shared/contracts/templates.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { FormDialog, FormField, Select, useFormErrors } from '../../ui/index.ts';

type Blueprint = Pick<TemplateSummaryDto, 'id' | 'name' | 'activeVersion'>;

/**
 * Use blueprint always ends on Make it yours. With an organization in scope (or only one that can
 * author) it goes straight there; otherwise this asks which organization, and Continue goes.
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
  const navigate = useNavigate();
  const scope = useOrgScope();
  // Only organizations where the person authors templates can receive one.
  const orgs = useMemo(
    () => scope.memberships.filter((m) => m.capabilities.includes('templates:author')),
    [scope.memberships],
  );
  const direct =
    orgs.find((m) => m.orgId === scope.orgId)?.orgId ??
    (orgs.length === 1 ? orgs[0]?.orgId : undefined);
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const check = useFormErrors({ org: chosen ? undefined : 'Choose an organization.' });
  const blueprintId = blueprint.id;
  const go = useCallback(
    (orgId: string) => {
      onOpenChange(false);
      void navigate({
        to: '/admin/o/$orgId/blueprints/$blueprintId/use',
        params: { orgId, blueprintId },
      });
    },
    [navigate, onOpenChange, blueprintId],
  );
  useEffect(() => {
    if (open && direct) go(direct);
  }, [open, direct, go]);
  if (direct) return null;
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Use blueprint"
      check={check}
      submitLabel="Continue"
      onSubmit={() => chosen && go(chosen)}
    >
      <FormField label="Organization" required error={check.errors.org}>
        {(c) => (
          <Select
            {...c}
            value={chosen}
            placeholder="Choose an organization"
            onValueChange={setChosen}
            options={orgs.map((m) => ({ value: m.orgId, label: m.orgName }))}
          />
        )}
      </FormField>
    </FormDialog>
  );
}
