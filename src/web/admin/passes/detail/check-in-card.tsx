import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  type CheckInPolicy,
  CheckInPolicySchema,
  PassCheckInSchema,
} from '@/shared/contracts/check-in.ts';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { api } from '@/web/lib/api.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { Button, Card, CardBody, CardHeader, ErrorState, toast } from '@/web/ui/index.ts';
import { CheckInFields } from '../../scanning/check-in-fields.tsx';
import { canMutatePass, passKeys, passMutationPrincipal } from '../api.ts';

export function CheckInCard({ pass, readOnly }: { pass: PassDetailDto; readOnly: boolean }) {
  const path = `/api/v1/passes/${pass.id}/check-in`;
  const client = useQueryClient();
  const settings = useQuery({
    queryKey: [...passKeys.detail(pass.id), 'check-in'],
    queryFn: () => api.get(path, PassCheckInSchema),
  });
  const [draft, setDraft] = useState<CheckInPolicy>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function save() {
    if (readOnly) return;
    const principalId = passMutationPrincipal(client);
    if (!principalId || !canMutatePass(client, pass, principalId)) return;
    setError(undefined);
    const parsed = CheckInPolicySchema.safeParse(draft ?? settings.data?.rules ?? {});
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check the rules.');
    setBusy(true);
    try {
      await api.put(path, PassCheckInSchema, { rules: parsed.data });
      if (!canMutatePass(client, pass, principalId)) return;
      await client.invalidateQueries({ queryKey: passKeys.detail(pass.id) });
      if (!canMutatePass(client, pass, principalId)) return;
      setDraft(undefined);
      toast.success('Check-in rules saved');
    } catch (cause) {
      if (canMutatePass(client, pass, principalId)) setError(errorMessage(cause));
    } finally {
      if (passMutationPrincipal(client) === principalId) setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader title="Check-in rules" />
      <CardBody className="flex flex-col gap-4">
        {settings.isError ? (
          <ErrorState inline error={settings.error} onRetry={() => void settings.refetch()} />
        ) : settings.data ? (
          <>
            <CheckInFields
              rules={draft ?? settings.data.rules}
              defaults={settings.data.defaults}
              onChange={setDraft}
              orgId={pass.orgId}
              disabled={readOnly || busy}
            />
            <p className="text-sm text-fg-muted">
              Scanner settings may add restrictions. In/out passes can leave after their entry
              window closes.
            </p>
            <div className="flex gap-2">
              <Button
                disabled={readOnly || busy || draft === undefined}
                loading={busy}
                onClick={() => void save()}
              >
                Save rules
              </Button>
              <Button variant="outline" disabled={readOnly || busy} onClick={() => setDraft({})}>
                Use template defaults
              </Button>
            </div>
          </>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}
