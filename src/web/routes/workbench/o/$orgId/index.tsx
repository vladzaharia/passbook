import { createFileRoute } from '@tanstack/react-router';
import { HomePage } from '../../../../workbench/tools/tool-home.tsx';

export const Route = createFileRoute('/workbench/o/$orgId/')({ component: HomePage });
