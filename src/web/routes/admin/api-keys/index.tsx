import { createFileRoute } from '@tanstack/react-router';
import { ApiKeysPage } from '../../../admin/api-keys/api-keys-page.tsx';

export const Route = createFileRoute('/admin/api-keys/')({ component: ApiKeysPage });
