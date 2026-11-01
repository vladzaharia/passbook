import { createFileRoute } from '@tanstack/react-router';
import { uploadSearchSchema } from '../../../admin/templates/search.ts';
import { TemplateUploadPage } from '../../../admin/templates/upload-page.tsx';

function UploadRoute() {
  const { templateId, upload } = Route.useSearch();
  return <TemplateUploadPage templateId={templateId} upload={upload} />;
}

export const Route = createFileRoute('/admin/templates/upload')({
  validateSearch: uploadSearchSchema,
  component: UploadRoute,
});
