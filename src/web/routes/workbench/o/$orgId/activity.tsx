import { createFileRoute } from '@tanstack/react-router';
import { ActivityPage } from '../../../../workbench/activity/activity-page.tsx';

export const Route = createFileRoute('/workbench/o/$orgId/activity')({ component: ActivityPage });
