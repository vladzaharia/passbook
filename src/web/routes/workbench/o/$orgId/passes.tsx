import { createFileRoute } from '@tanstack/react-router';
import { PassesPage } from '../../../../workbench/tools/tool-passes.tsx';

export const Route = createFileRoute('/workbench/o/$orgId/passes')({ component: PassesPage });
