import { createFileRoute } from '@tanstack/react-router';
import { SandboxPage } from '../../../../workbench/tools/tool-sandbox.tsx';

export const Route = createFileRoute('/workbench/o/$orgId/sandbox')({ component: SandboxPage });
