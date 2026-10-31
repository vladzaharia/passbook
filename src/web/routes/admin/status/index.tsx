import { createFileRoute } from '@tanstack/react-router';
import { StatusPage } from '../../../admin/status/status-page.tsx';

export const Route = createFileRoute('/admin/status/')({ component: StatusPage });
