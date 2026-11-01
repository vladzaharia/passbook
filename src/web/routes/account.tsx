import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { AccountPage } from '../portal/account-page.tsx';

export const Route = createFileRoute('/account')({
  /** ?add=email (from the empty My passes): focus the add-email row. */
  validateSearch: z.object({ add: z.enum(['email']).optional().catch(undefined) }),
  component: function AccountRoute() {
    const { add } = Route.useSearch();
    return <AccountPage focusAdd={add === 'email'} />;
  },
});
