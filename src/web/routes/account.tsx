import { createFileRoute } from '@tanstack/react-router';
import { useCallback } from 'react';
import { accountSearchSchema } from '../lib/route-search.ts';
import { AccountPage } from '../portal/account-page.tsx';

export const Route = createFileRoute('/account')({
  validateSearch: accountSearchSchema,
  component: function AccountRoute() {
    const { add, verified } = Route.useSearch();
    const navigate = Route.useNavigate();
    // The add-email link lands here with ?verified=<email>; the address leaves the URL at once.
    const drop = useCallback(
      () => void navigate({ search: (s) => ({ ...s, verified: undefined }), replace: true }),
      [navigate],
    );
    return <AccountPage focusAdd={add === 'email'} verified={verified} onVerifiedShown={drop} />;
  },
});
