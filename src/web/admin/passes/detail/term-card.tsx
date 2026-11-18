import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import type { PassTermDto } from '@/shared/contracts/pass-term.ts';
import { type PassDetailDto, PassDetailSchema } from '@/shared/contracts/passes.ts';
import { api } from '@/web/lib/api.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { formatDay } from '@/web/lib/format.ts';
import { Button, Card, CardBody, CardHeader, toast } from '@/web/ui/index.ts';
import { canMutatePass, passKeys, passMutationPrincipal } from '../api.ts';

/** A pass's term end, with the one move: renew. */
export function TermCard({
  pass,
  term,
  readOnly,
}: {
  pass: PassDetailDto;
  term: PassTermDto;
  readOnly: boolean;
}) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const end = term.end ? Date.parse(term.end) : null;

  async function renew() {
    if (readOnly) return;
    const principalId = passMutationPrincipal(client);
    if (!principalId || !canMutatePass(client, pass, principalId)) return;
    setError(undefined);
    setBusy(true);
    try {
      const next = await api.post(`/api/v1/passes/${pass.id}/renew`, PassDetailSchema, {});
      if (!canMutatePass(client, pass, principalId)) return;
      client.setQueryData(passKeys.detail(pass.id), next);
      await client.invalidateQueries({ queryKey: passKeys.all });
      toast.success('Term renewed');
    } catch (cause) {
      if (canMutatePass(client, pass, principalId)) setError(errorMessage(cause));
    } finally {
      if (passMutationPrincipal(client) === principalId) setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Term" />
      <CardBody className="flex flex-col gap-3">
        <p className="text-sm text-fg-muted">
          {end === null ? 'Not started.' : `Ends ${formatDay(end)}.`}
        </p>
        <div>
          <Button
            variant="outline"
            iconStart={<RefreshCw aria-hidden />}
            loading={busy}
            disabled={readOnly || busy || end === null}
            onClick={() => void renew()}
          >
            Renew
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}
