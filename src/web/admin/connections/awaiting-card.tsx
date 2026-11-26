import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo } from 'react';
import type { z } from 'zod';
import type { ConnectionDetailSchema } from '@/shared/contracts/connections.ts';
import { Button, toast } from '../../ui/index.ts';
import { useOrgTimeZone } from '../settings/use-org-time-zone.ts';
import { connectionKeys, useConnectionActions } from './api.ts';
import { ProviderLive } from './provider-panel.tsx';
import { arrivalLoader, useConnectionSetup } from './setup-api.ts';

/**
 * A webhook connection that has not had a verified delivery: the live check from setup, with the
 * same fixes and the way back into it. The first signed delivery turns the connection healthy,
 * and the card goes.
 */
export function AwaitingCard({ c }: { c: z.infer<typeof ConnectionDetailSchema> }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const zone = useOrgTimeZone(c.orgId);
  const actions = useConnectionActions(c.id);
  const setup = useConnectionSetup(c.id);
  const load = useMemo(() => arrivalLoader(c.id), [c.id]);
  if (!setup.data) return null;
  const toSetup = (step?: 'secret') =>
    void navigate({
      to: '/admin/connections/$connectionId/setup',
      params: { connectionId: c.id },
      ...(step ? { search: { step } } : {}),
    });
  return (
    <div className="mb-6 flex min-w-0 flex-col gap-3">
      <ProviderLive
        setup={setup.data}
        connection={c}
        load={load}
        zone={zone}
        onState={(s) => {
          if (s.verified) void qc.invalidateQueries({ queryKey: connectionKeys.detail(c.id) });
        }}
        actions={{
          replaceSecret: () => toSetup('secret'),
          goToSecret: () => toSetup('secret'),
          turnOnTestEvents: () =>
            actions.update.mutate(
              { config: { ...c.config, acceptTestEvents: true } },
              { onSuccess: () => toast.success('Test events on') },
            ),
        }}
      />
      <div>
        <Button onClick={() => toSetup()}>Finish setup</Button>
      </div>
    </div>
  );
}
