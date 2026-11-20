import { createFileRoute } from '@tanstack/react-router';
import { PlatformRetentionPage } from '../../../../admin/retention/platform-retention-page.tsx';

export const Route = createFileRoute('/admin/platform/retention/')({
  component: PlatformRetentionPage,
});
