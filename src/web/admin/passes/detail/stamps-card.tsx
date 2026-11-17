import { useQueryClient } from '@tanstack/react-query';
import { Gift, Plus } from 'lucide-react';
import { useState } from 'react';
import { type PassDetailDto, PassDetailSchema } from '@/shared/contracts/passes.ts';
import type { PassStampsAction, PassStampsDto } from '@/shared/contracts/stamps.ts';
import { api } from '@/web/lib/api.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { Badge, Button, Card, CardBody, CardHeader, Celebrate, toast } from '@/web/ui/index.ts';
import { StampGrid } from '../../templates/designer/stamp-grid.tsx';
import { canMutatePass, passKeys, passMutationPrincipal } from '../api.ts';

const DONE: Record<PassStampsAction['action'], string> = {
  add: 'Stamp added',
  redeem: 'Reward redeemed',
};

/** A stamp card's count, with the desk's two moves: add a stamp, redeem the reward. */
export function StampsCard({
  pass,
  stamps,
  readOnly,
}: {
  pass: PassDetailDto;
  stamps: PassStampsDto;
  readOnly: boolean;
}) {
  const client = useQueryClient();
  const [busy, setBusy] = useState<PassStampsAction['action'] | null>(null);
  const [error, setError] = useState<string>();
  // Sparks for the stamp that fills the card, not for every visit to a ready one.
  const [cheer, setCheer] = useState(false);
  const full = stamps.count >= stamps.maximum;
  const extra = stamps.count - stamps.card;

  async function act(action: PassStampsAction) {
    if (readOnly) return;
    const principalId = passMutationPrincipal(client);
    if (!principalId || !canMutatePass(client, pass, principalId)) return;
    setError(undefined);
    setBusy(action.action);
    try {
      const next = await api.post(`/api/v1/passes/${pass.id}/stamps`, PassDetailSchema, action);
      if (!canMutatePass(client, pass, principalId)) return;
      client.setQueryData(passKeys.detail(pass.id), next);
      if (next.stamps?.ready && !stamps.ready) setCheer(true);
      await client.invalidateQueries({ queryKey: passKeys.all });
      toast.success(DONE[action.action]);
    } catch (cause) {
      if (canMutatePass(client, pass, principalId)) setError(errorMessage(cause));
    } finally {
      if (passMutationPrincipal(client) === principalId) setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Stamps"
        actions={
          stamps.ready ? (
            <span className="relative">
              <Badge tone="success">Reward ready</Badge>
              <Celebrate when={cheer} />
            </span>
          ) : null
        }
      />
      <CardBody className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
          <StampGrid goal={stamps.goal} count={stamps.card} className="max-w-xs" />
          <div className="flex flex-col gap-1">
            <p className="text-2xl font-semibold tabular-nums text-fg-strong" aria-live="polite">
              {stamps.card} of {stamps.goal}
            </p>
            <p className="text-sm text-fg-muted">
              {stamps.ready
                ? `Ready to redeem.${extra > 0 ? ` ${extra} saved for the next card.` : ''}`
                : `${stamps.goal - stamps.card} more for the reward.`}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            iconStart={<Plus aria-hidden />}
            loading={busy === 'add'}
            disabled={readOnly || busy !== null || full}
            onClick={() => void act({ action: 'add', count: 1 })}
          >
            Add stamp
          </Button>
          <Button
            variant="outline"
            iconStart={<Gift aria-hidden />}
            loading={busy === 'redeem'}
            disabled={readOnly || busy !== null || !stamps.ready}
            onClick={() => void act({ action: 'redeem' })}
          >
            Redeem reward
          </Button>
        </div>
        {full ? (
          <p className="text-sm text-fg-muted">The card is full. Redeem the reward first.</p>
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
