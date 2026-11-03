import { createFileRoute } from '@tanstack/react-router';
import { accountSearchSchema } from '../../lib/nav.ts';
import { UNSCOPED_SEARCH } from '../../lib/org-filter.tsx';
import { AccountPage } from '../../portal/account-page.tsx';

/** The holder's Account page inside the console: the account menu opens it here from /admin. */
export const Route = createFileRoute('/admin/account')({
  search: UNSCOPED_SEARCH,
  validateSearch: accountSearchSchema,
  component: function AdminAccountRoute() {
    const { add } = Route.useSearch();
    return <AccountPage focusAdd={add === 'email'} />;
  },
});
