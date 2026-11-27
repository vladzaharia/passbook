import { createFileRoute } from '@tanstack/react-router';
import { EventsPage } from '../../../../workbench/tools/tool-events.tsx';

export const Route = createFileRoute('/workbench/o/$orgId/events')({ component: EventsPage });
