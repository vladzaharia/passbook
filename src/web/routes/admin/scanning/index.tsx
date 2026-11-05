import { createFileRoute } from '@tanstack/react-router';
import { ScanningPage } from '../../../admin/scanning/scanning-page.tsx';

export const Route = createFileRoute('/admin/scanning/')({ component: ScanningPage });
