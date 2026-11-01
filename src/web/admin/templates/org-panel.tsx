import { useState } from 'react';
import { errorMessage } from '../../lib/errors.ts';
import { useOrgOptions } from '../../lib/search.ts';
import { Button, Card, CardBody, CardHeader, FormField, Select, toast } from '../../ui/index.ts';
import { useTemplateActions } from './api.ts';

const NONE = 'none';

export function OrgPanel({ templateId, orgId }: { templateId: string; orgId: string | null }) {
  const orgs = useOrgOptions();
  const actions = useTemplateActions(templateId);
  const [value, setValue] = useState(orgId ?? NONE);
  const [error, setError] = useState<string>();
  const dirty = value !== (orgId ?? NONE);

  async function save() {
    setError(undefined);
    try {
      await actions.assignOrg.mutateAsync(value === NONE ? null : value);
      toast.success('Organization saved');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <Card className="max-w-3xl">
      <CardHeader title="Organization" />
      <CardBody className="grid gap-3">
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
                { value: NONE, label: 'None' },
                ...(orgs.data?.items ?? []).map((o) => ({ value: o.id, label: o.name })),
              ]}
            />
          )}
        </FormField>
        <div>
          <Button
            loading={actions.assignOrg.isPending}
            disabled={!dirty}
            onClick={() => void save()}
          >
            Save
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
