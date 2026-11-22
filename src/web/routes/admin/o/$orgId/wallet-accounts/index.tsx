import { createFileRoute, redirect } from '@tanstack/react-router';

/** Wallet accounts moved into the Channels card of Brand and channels. */
export const Route = createFileRoute('/admin/o/$orgId/wallet-accounts/')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/admin/o/$orgId/brand',
      params: { orgId: params.orgId },
      hash: 'channels',
      replace: true,
    });
  },
});
