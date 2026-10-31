import { createFileRoute } from '@tanstack/react-router';
import { TemplateUploadPage } from '../../../admin/templates/upload-page.tsx';

export const Route = createFileRoute('/admin/templates/upload')({
  component: TemplateUploadPage,
});
