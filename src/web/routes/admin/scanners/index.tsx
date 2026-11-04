import { createFileRoute } from '@tanstack/react-router';
import { ScannersPage } from '../../../admin/scanners/scanners-page.tsx';

export const Route = createFileRoute('/admin/scanners/')({ component: ScannersPage });
