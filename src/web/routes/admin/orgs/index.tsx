import { createFileRoute } from '@tanstack/react-router';
import { OrgsPage } from '../../../admin/orgs/orgs-page.tsx';

export const Route = createFileRoute('/admin/orgs/')({ component: OrgsPage });
