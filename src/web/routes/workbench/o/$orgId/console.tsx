import { createFileRoute } from '@tanstack/react-router';
import { ConsoleToolPage } from '../../../../workbench/tools/tool-console.tsx';

export const Route = createFileRoute('/workbench/o/$orgId/console')({ component: ConsoleToolPage });
