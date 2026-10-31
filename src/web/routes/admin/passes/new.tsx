import { createFileRoute } from '@tanstack/react-router';
import { NewPassPage } from '../../../admin/passes/new-pass-page.tsx';

export const Route = createFileRoute('/admin/passes/new')({
  component: NewPassPage,
});
