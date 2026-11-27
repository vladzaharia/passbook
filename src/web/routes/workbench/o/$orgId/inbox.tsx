import { createFileRoute } from '@tanstack/react-router';
import { InboxPage } from '../../../../workbench/inbox/inbox-page.tsx';

export const Route = createFileRoute('/workbench/o/$orgId/inbox')({ component: InboxPage });
