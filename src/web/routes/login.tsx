import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { LOGIN_REASON_KEYS } from '@/shared/copy/login-reasons.ts';
import { LoginPage } from '../portal/login-page.tsx';

export const Route = createFileRoute('/login')({
  validateSearch: z.object({
    next: z.string().optional().catch(undefined),
    /** ?reason= (LOGIN_REASONS): one line above the form. */
    reason: z.enum(LOGIN_REASON_KEYS).optional().catch(undefined),
    /** /login?focus=email (from /auth/no-access); the email field is focused first anyway. */
    focus: z.enum(['email']).optional().catch(undefined),
  }),
  component: function LoginRoute() {
    const { next, reason } = Route.useSearch();
    return <LoginPage next={next} reason={reason} />;
  },
});
