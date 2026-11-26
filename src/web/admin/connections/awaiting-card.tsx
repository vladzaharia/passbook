import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { LiveCheck } from '../../ui/webhook-setup/index.ts';
import { useOrgTimeZone } from '../settings/use-org-time-zone.ts';
import { connectionKeys } from './api.ts';
import { arrivalLoader, useConnectionSetup } from './setup-api.ts';

/**
 * A webhook connection that has not had a verified delivery: the live check from setup, with the
 * way back into it. The first signed delivery turns the connection healthy, and the card goes.
 */
export function AwaitingCard({ c }: { c: { id: string; orgId: string; createdAt: number } }) {
  const { id: connectionId, orgId, createdAt } = c;
  const qc = useQueryClient();
  const zone = useOrgTimeZone(orgId);
  const setup = useConnectionSetup(connectionId);
  const load = useMemo(() => arrivalLoader(connectionId), [connectionId]);
  if (!setup.data) return null;
  const guide = setup.data;
  return (
    <div className="mb-6 flex min-w-0 flex-col gap-3">
      <LiveCheck
        mode="listen"
        provider={guide.recipe === 'custom' ? 'your system' : guide.provider.name}
        load={load}
        since={createdAt}
        topics={guide.subscriptions.topics}
        origin={guide.secret.origin}
        recipeFix={guide.troubleshooting}
        zone={zone}
        onChange={(s) => {
          if (s.verified)
            void qc.invalidateQueries({ queryKey: connectionKeys.detail(connectionId) });
        }}
      />
      <Link
        to="/admin/connections/$connectionId/setup"
        params={{ connectionId }}
        className="w-fit text-sm font-medium text-fg-strong underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-focus"
      >
        Finish setup
      </Link>
    </div>
  );
}
