import { createFileRoute } from '@tanstack/react-router';
import { KeysToolPage } from '../../../../workbench/tools/tool-keys.tsx';

export const Route = createFileRoute('/workbench/o/$orgId/keys')({ component: KeysToolPage });
