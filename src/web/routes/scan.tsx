import { createFileRoute } from '@tanstack/react-router';
import { ScanPage } from '../scan/scan-page.tsx';

export const Route = createFileRoute('/scan')({ component: ScanPage });
