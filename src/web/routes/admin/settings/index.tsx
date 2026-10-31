import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '../../../admin/settings/settings-page.tsx';

export const Route = createFileRoute('/admin/settings/')({ component: SettingsPage });
