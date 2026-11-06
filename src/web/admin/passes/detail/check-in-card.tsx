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
import { passKeys } from '../api.ts';

export function CheckInCard({ pass, foreign }: { pass: PassDetailDto; foreign: boolean }) {
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
    setError(undefined);
    const parsed = CheckInPolicySchema.safeParse(draft ?? settings.data?.rules ?? {});
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check the rules.');
    setBusy(true);
    try {
      await api.put(path, PassCheckInSchema, { rules: parsed.data });
      await client.invalidateQueries({ queryKey: passKeys.detail(pass.id) });
      setDraft(undefined);
      toast.success('Check-in rules saved');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
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
              disabled={foreign || busy}
            />
            <p className="text-sm text-fg-muted">
              Scanner settings may add restrictions. In/out passes can leave after their entry
              window closes.
            </p>
            <div className="flex gap-2">
              <Button
                disabled={foreign || busy || draft === undefined}
                loading={busy}
                onClick={() => void save()}
              >
                Save rules
              </Button>
              <Button variant="outline" disabled={foreign || busy} onClick={() => setDraft({})}>
                Use template defaults
              </Button>
            </div>
          </>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger-fg">
            {error}
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}
