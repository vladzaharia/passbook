import { createFileRoute } from '@tanstack/react-router';
import { accountSearchSchema } from '../lib/route-search.ts';
import { AccountPage } from '../portal/account-page.tsx';

export const Route = createFileRoute('/account')({
  validateSearch: accountSearchSchema,
  component: function AccountRoute() {
    const { add, verified } = Route.useSearch();
    return <AccountPage focusAdd={add === 'email'} verified={verified} />;
  },
});
