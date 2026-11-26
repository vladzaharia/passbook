import { createFileRoute } from '@tanstack/react-router';
import { LogsPage } from '../../../../workbench/tools/tool-logs.tsx';

export const Route = createFileRoute('/workbench/o/$orgId/logs')({ component: LogsPage });
